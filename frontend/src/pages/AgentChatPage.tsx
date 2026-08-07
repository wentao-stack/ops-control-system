import { useEffect, useRef, useState, useCallback } from "react"
import { api } from "../auth"
import { AgentConversation, AgentMessage, fmtRel } from "../types"

const SUGGESTIONS = [
  "各主機監控狀況如何？",
  "有哪些服務在運行？",
  "最近有什麼告警？",
  "列出所有資產",
]

type PendingConfirm = {
  confirm_id: string
  name: string
  parameters: Record<string, any>
  level?: string
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function groupConversations(convs: AgentConversation[]): Map<string, AgentConversation[]> {
  const groups = new Map<string, AgentConversation[]>()
  const now = Date.now()
  const dayMs = 86400000

  for (const c of convs) {
    const age = now - new Date(c.updated_at).getTime()
    let label: string
    if (age < dayMs) label = "今天"
    else if (age < dayMs * 2) label = "昨天"
    else label = "更早"
    groups.set(label, [...(groups.get(label) ?? []), c])
  }
  // ensure ordering
  const ordered = new Map<string, AgentConversation[]>()
  for (const key of ["今天", "昨天", "更早"]) {
    if (groups.has(key)) ordered.set(key, groups.get(key)!)
  }
  return ordered
}

/* simple markdown → html (no external dep) */
function renderMarkdown(text: string): string {
  let html = text
    // code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, __, code) => `<pre><code>${esc(code.trim())}</code></pre>`)
    // inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // tables
    .replace(/\|(.+)\|\n\|[-| :]+\|\n((?:\|.+|\n?)*)/g, (_, header, body) => {
      const ths = header.split("|").map((c: string) => c.trim()).filter(Boolean).map((c: string) => `<th>${c}</th>`).join("")
      const rows = body.trim().split("\n").map((row: string) => {
        const tds = row.split("|").map((c: string) => c.trim()).filter(Boolean).map((c: string) => `<td>${c}</td>`).join("")
        return `<tr>${tds}</tr>`
      }).join("")
      return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`
    })
    // newlines
    .replace(/\n/g, "<br>")

  return html
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/* ── sub-components (inline) ─────────────────────────────────────────────── */

function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: AgentConversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  const groups = groupConversations(conversations)

  return (
    <div className="agent-sidebar">
      <div className="agent-sidebar-header">
        <button className="btn btn-primary" style={{ width: "100%" }} onClick={onNew}>
          ＋ 新對話
        </button>
      </div>
      <div className="agent-sidebar-list">
        {Array.from(groups.entries()).map(([label, convs]) => (
          <div key={label}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", padding: "8px 12px 4px", textTransform: "uppercase", letterSpacing: 0.5 }}>
              {label}
            </div>
            {convs.map(c => (
              <div
                key={c.id}
                className={`agent-chat-item${c.id === activeId ? " active" : ""}`}
                onClick={() => onSelect(c.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (window.confirm(`刪除對話「${c.title}」？`)) onDelete(c.id)
                }}
              >
                <div className="agent-chat-item-title">{c.title}</div>
                <div className="agent-chat-item-time">{fmtRel(c.updated_at)}</div>
              </div>
            ))}
          </div>
        ))}
        {conversations.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--text-secondary)" }}>
            尚無對話歷史
          </div>
        )}
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: AgentMessage }) {
  const isUser = msg.role === "user"
  const isTool = msg.role === "tool"

  if (isTool && msg.tool_name) {
    return (
      <div className="agent-tool-card">
        <div className="agent-tool-header">
          <span>⚙</span>
          <span>{msg.tool_name}</span>
          {msg.tool_input && (
            <span style={{ fontWeight: 400, opacity: 0.7 }}>
              {JSON.parse(msg.tool_input || "{}") && Object.entries(JSON.parse(msg.tool_input)).map(([k, v]) => `${k}=${v}`).join(" ")}
            </span>
          )}
        </div>
        {msg.tool_result && (
          <div className="agent-tool-body">{msg.tool_result}</div>
        )}
      </div>
    )
  }

  return (
    <div className={`agent-msg ${isUser ? "user" : "assistant"}`}>
      <div className="agent-msg-avatar">{isUser ? "👤" : "🤖"}</div>
      <div className="agent-msg-content">
        <div
          className="agent-msg-bubble"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
        />
        {msg.role === "assistant" && msg.usage && (
          <div className="agent-msg-usage">
            📊 {msg.usage.total_tokens.toLocaleString()} tokens
            {msg.usage.tool_calls > 0 && ` · ${msg.usage.tool_calls} tools`}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── main page ───────────────────────────────────────────────────────────── */

export function AgentChatPage() {
  const [tab, setTab] = useState<"chat" | "usage">("chat")
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [llmReady, setLlmReady] = useState(true)
  const [creatingConv, setCreatingConv] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [confirming, setConfirming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /* load conversations */
  const loadConversations = useCallback(() => {
    api<{ conversations: AgentConversation[] }>(`/api/v1/agent/conversations`)
      .then(r => setConversations(r.conversations))
      .catch(() => setConversations([]))
  }, [])

  /* load messages for a conversation */
  const loadMessages = useCallback((convId: string) => {
    api<{ messages: AgentMessage[] }>(`/api/v1/agent/conversations/${convId}/messages`)
      .then(r => setMessages(r.messages))
      .catch(() => setMessages([]))
  }, [])

  /* check LLM health */
  useEffect(() => {
    api<{ status: string }>(`/api/v1/agent/health`)
      .then(r => setLlmReady(r.status === "ok"))
      .catch(() => setLlmReady(false))
  }, [])

  /* initial load */
  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  /* scroll to bottom on new messages */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  /* auto-resize textarea */
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = "auto"
      el.style.height = Math.min(el.scrollHeight, 120) + "px"
    }
  }, [input])

  /* create new conversation */
  const handleNew = async () => {
    if (creatingConv) return
    setCreatingConv(true)
    try {
      const r = await api<AgentConversation>(`/api/v1/agent/conversations`, { method: "POST" })
      setConversations(prev => [r, ...prev])
      setActiveId(r.id)
      setMessages([])
    } catch {
      // fallback: local-only new conversation state
      const id = `local-${Date.now()}`
      setActiveId(id)
      setMessages([])
    } finally {
      setCreatingConv(false)
    }
  }

  /* create new conversation and return the id (for handleSend auto-create) */
  const handleNewAndGetId = async (): Promise<string> => {
    if (creatingConv) {
      // Already creating, wait a bit and retry
      await new Promise(r => setTimeout(r, 200))
      return activeId ?? handleNewAndGetId()
    }
    setCreatingConv(true)
    try {
      const r = await api<AgentConversation>(`/api/v1/agent/conversations`, { method: "POST" })
      setConversations(prev => [r, ...prev])
      setActiveId(r.id)
      setMessages([])
      return r.id
    } catch {
      const id = `local-${Date.now()}`
      setActiveId(id)
      setMessages([])
      return id
    } finally {
      setCreatingConv(false)
    }
  }

  /* delete conversation */
  const handleDelete = async (id: string) => {
    try {
      await api(`/api/v1/agent/conversations/${id}`, { method: "DELETE" })
    } catch { /* ignore */ }
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeId === id) {
      setActiveId(null)
      setMessages([])
    }
    loadConversations()
  }

  /* select conversation */
  const handleSelect = (id: string) => {
    setActiveId(id)
    loadMessages(id)
  }

  /* send message with SSE streaming */
  const handleSend = async (text?: string) => {
    const message = text || input.trim()
    if (!message || streaming) return

    setInput("")
    let convId = activeId
    // Auto-create conversation if none active
    if (!convId) {
      convId = await handleNewAndGetId()
    }

    // optimistically add user message
    const userMsg: AgentMessage = {
      id: Date.now(),
      conversation_id: convId ?? "",
      role: "user",
      content: message,
      tool_name: null,
      tool_input: null,
      tool_result: null,
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])

    // placeholder assistant message for streaming (this is the ONLY bubble)
    const assistantId = Date.now() + 1
    setMessages(prev => [...prev, {
      id: assistantId,
      conversation_id: convId ?? "",
      role: "assistant",
      content: "",
      tool_name: null,
      tool_input: null,
      tool_result: null,
      created_at: new Date().toISOString(),
    }])

    setStreaming(true)
    const abortCtrl = new AbortController()
    abortRef.current = abortCtrl

    try {
      const body = JSON.stringify({
        conversation_id: convId,
        message,
      })

      const response = await api<Response>(`/api/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: abortCtrl.signal,
      })

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`)
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim()
              if (data === "[DONE]") continue

              try {
                const parsed = JSON.parse(data)
                if (parsed.event === "conv_id") {
                  // Backend auto-created a conversation — update activeId
                  if (!convId) {
                    setActiveId(parsed.conv_id)
                  }
                } else if (parsed.event === "token") {
                  // append streaming token
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantId
                        ? { ...m, content: m.content + (parsed.token ?? parsed.data ?? "") }
                        : m
                    )
                  )
                } else if (parsed.event === "tool_use") {
                  // add tool message
                  const toolMsg: AgentMessage = {
                    id: Date.now() + Math.random(),
                    conversation_id: convId ?? "",
                    role: "tool",
                    content: "",
                    tool_name: parsed.name,
                    tool_input: JSON.stringify(parsed.parameters ?? {}),
                    tool_result: null,
                    created_at: new Date().toISOString(),
                  }
                  setMessages(prev => [...prev, toolMsg])
                } else if (parsed.event === "tool_result") {
                  setMessages(prev =>
                    prev.map(m =>
                      m.role === "tool" && m.tool_name === parsed.name
                        ? { ...m, tool_result: parsed.result }
                        : m
                    )
                  )
                } else if (parsed.event === "confirm") {
                  // Show confirmation dialog for dangerous tools
                  setPendingConfirm({
                    confirm_id: parsed.confirm_id,
                    name: parsed.name,
                    parameters: parsed.parameters ?? {},
                    level: parsed.level ?? "exec",
                  })
                } else if (parsed.event === "done") {
                  // Attach usage info to last assistant message
                  if (parsed.usage) {
                    setMessages(prev =>
                      prev.map(m =>
                        m.id === assistantId
                          ? { ...m, usage: parsed.usage }
                          : m
                      )
                    )
                  }
                }
              } catch {
                // non-JSON data line, treat as token
                setMessages(prev =>
                  prev.map(m =>
                    m.id === assistantId ? { ...m, content: m.content + data } : m
                  )
                )
              }
            }
          }
        }
      }

      // SSE stream complete — messages already updated via streaming, no need to reload
    } catch (e: any) {
      if (e.name !== "AbortError") {
        // show error in chat
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantId
              ? { ...m, content: `⚠ 請求失敗：${e.message ?? "未知錯誤"}` }
              : m
          )
        )
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      // reload conversations so sidebar reflects the updated state
      loadConversations()
    }
  }

  /* stop streaming */
  const handleStop = () => {
    abortRef.current?.abort()
  }

  /* confirm/reject tool execution */
  const handleConfirmTool = async (approved: boolean) => {
    if (!pendingConfirm || confirming) return
    setConfirming(true)
    try {
      await api(`/api/v1/agent/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm_id: pendingConfirm.confirm_id,
          approved,
        }),
      })
    } catch {
      // ignore — backend may have already processed
    } finally {
      setPendingConfirm(null)
      setConfirming(false)
    }
  }

  /* handle keyboard */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div className="agent-chat">
      {/* Tab switcher */}
      <div className="agent-tabs">
        <button className={`agent-tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>💬 聊天</button>
        <button className={`agent-tab ${tab === "usage" ? "active" : ""}`} onClick={() => setTab("usage")}>📊 用量統計</button>
      </div>

      {tab === "chat" ? (
      <div className="agent-chat-body">
      <>
      {/* Sidebar */}
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
      />

      {/* Main chat area */}
      <div className="agent-main">
        {/* Messages */}
        <div className="agent-messages">
          {!activeId && messages.length === 0 && (
            <div className="agent-empty">
              <div className="agent-empty-icon">🤖</div>
              <h3>AI 助手</h3>
              <p>我可以幫您查看主機、服務、告警等 OPS 資源</p>
              <div className="agent-suggestions">
                {SUGGESTIONS.map(s => (
                  <button key={s} className="agent-suggestion" onClick={() => {
                    setInput(s)
                    // handleSend will auto-create conversation if needed
                    setTimeout(() => handleSend(s), 50)
                  }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}

          <div ref={messagesEndRef} />
        </div>

        {/* Confirmation card */}
        {pendingConfirm && (
          <div className="agent-confirm-overlay">
            <div className="agent-confirm-card">
              <div className="agent-confirm-header">
                <span className="agent-confirm-icon">⚠️</span>
                <span className="agent-confirm-title">需要確認操作</span>
              </div>
              <div className="agent-confirm-body">
                <div className="agent-confirm-tool">
                  <strong>工具:</strong> {pendingConfirm.name}
                </div>
                <div className="agent-confirm-params">
                  <strong>參數:</strong>
                  <pre>{JSON.stringify(pendingConfirm.parameters, null, 2)}</pre>
                </div>
                <div className={`agent-confirm-risk agent-confirm-risk-${pendingConfirm.level ?? "exec"}`}>
                  {pendingConfirm.level === "exec" && "🔴 高風險 — 執行類操作"}
                  {pendingConfirm.level === "write" && "🟡 中風險 — 寫入類操作"}
                  {pendingConfirm.level === "read" && "🟢 低風險 — 讀取類操作"}
                </div>
                <div className="agent-confirm-warning">
                  ⚡ 此操作可能影響系統運行，請確認後繼續
                </div>
              </div>
              <div className="agent-confirm-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => handleConfirmTool(false)}
                  disabled={confirming}
                >
                  ✕ 取消
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => handleConfirmTool(true)}
                  disabled={confirming}
                >
                  ✓ {confirming ? "執行中..." : "確認執行"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Input area */}
        <div className="agent-input-area">
          <div className="agent-input-wrapper">
            <textarea
              ref={textareaRef}
              className="agent-input-textarea"
              placeholder="輸入訊息... (Enter 發送, Shift+Enter 換行)"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            {streaming ? (
              <button className="agent-stop-btn" onClick={handleStop} title="停止">
                ■
              </button>
            ) : (
              <button
                className="agent-send-btn"
                onClick={() => handleSend()}
                disabled={!input.trim()}
                title="發送"
              >
                ▶
              </button>
            )}
          </div>
        </div>
      </div>
      </>
      </div>
      ) : (
      <AgentUsagePanel />
      )}
    </div>
  )
}

/* ── Usage stats panel ─────────────────────────────────────────────────────── */

interface UsageData {
  period: string
  total_prompt_tokens: number
  total_completion_tokens: number
  total_tokens: number
  total_tool_calls: number
  total_requests: number
  user_breakdown: Record<string, { total_tokens: number; tool_calls: number; requests: number }>
  daily: { date: string; total_tokens: number; requests: number; tool_calls: number }[]
  records: {
    id: number
    user: string
    conversation_id: string
    model: string
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    tool_calls_count: number
    created_at: string
  }[]
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return n.toString()
}

function AgentUsagePanel() {
  const [subTab, setSubTab] = useState<"usage" | "memories" | "inspect">("usage")
  const [data, setData] = useState<UsageData | null>(null)
  const [period, setPeriod] = useState("month")
  const [loading, setLoading] = useState(false)

  const load = useCallback((p: string) => {
    setLoading(true)
    api<UsageData>(`/api/v1/agent/usage?period=${p}`)
      .then(r => setData(r))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(period) }, [period, load])

  if (!data && !loading) return <div className="usage-empty">載入失敗，請稍後再試</div>
  if (loading) return <div className="usage-empty">載入中...</div>
  if (!data) return <div className="usage-empty">暫無用量數據</div>

  const maxTokens = Math.max(...data.daily.map(d => d.total_tokens), 1)

  return (
    <div className="usage-panel">
      {/* Sub-tab switcher */}
      <div className="usage-sub-tabs">
        <button className={`usage-sub-tab ${subTab === "usage" ? "active" : ""}`} onClick={() => setSubTab("usage")}>📊 用量統計</button>
        <button className={`usage-sub-tab ${subTab === "memories" ? "active" : ""}`} onClick={() => setSubTab("memories")}>🧠 記憶管理</button>
        <button className={`usage-sub-tab ${subTab === "inspect" ? "active" : ""}`} onClick={() => setSubTab("inspect")}>🔍 系統檢查</button>
      </div>

      {subTab === "usage" ? (
      <div className="usage-content">
      <div className="usage-header">
        <h3>📊 Token 用量統計</h3>
        <div className="usage-period">
          {(["today", "week", "month", "all"] as const).map(p => (
            <button
              key={p}
              className={`usage-period-btn ${period === p ? "active" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p === "today" ? "今天" : p === "week" ? "近7天" : p === "month" ? "本月" : "全部"}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="usage-cards">
        <div className="usage-card">
          <div className="usage-card-value">{fmtTokens(data.total_tokens)}</div>
          <div className="usage-card-label">總 Token 數</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-value">{fmtTokens(data.total_prompt_tokens)}</div>
          <div className="usage-card-label">Prompt Token</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-value">{fmtTokens(data.total_completion_tokens)}</div>
          <div className="usage-card-label">Completion Token</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-value">{data.total_requests}</div>
          <div className="usage-card-label">請求次數</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-value">{data.total_tool_calls}</div>
          <div className="usage-card-label">工具調用次數</div>
        </div>
      </div>

      {/* Daily chart */}
      {data.daily.length > 0 && (
        <div className="usage-chart">
          <h4>每日用量</h4>
          <div className="usage-bars">
            {[...data.daily].reverse().map(d => (
              <div key={d.date} className="usage-bar-group" title={`${d.date}: ${d.total_tokens} tokens, ${d.requests} requests`}>
                <div
                  className="usage-bar"
                  style={{ height: `${Math.max((d.total_tokens / maxTokens) * 100, 4)}%` }}
                />
                <div className="usage-bar-label">{d.date.slice(5)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* User breakdown (admin only) */}
      {Object.keys(data.user_breakdown).length > 0 && (
        <div className="usage-user-breakdown">
          <h4>用戶明細</h4>
          <table className="usage-table">
            <thead>
              <tr>
                <th>用戶</th>
                <th>Token 數</th>
                <th>請求次數</th>
                <th>工具調用</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.user_breakdown).map(([user, info]) => (
                <tr key={user}>
                  <td>{user}</td>
                  <td>{fmtTokens(info.total_tokens)}</td>
                  <td>{info.requests}</td>
                  <td>{info.tool_calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent records */}
      {data.records.length > 0 && (
        <div className="usage-records">
          <h4>最近記錄</h4>
          <table className="usage-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>用戶</th>
                <th>模型</th>
                <th>Token</th>
                <th>工具調用</th>
              </tr>
            </thead>
            <tbody>
              {data.records.slice(0, 20).map(r => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleString("zh-TW")}</td>
                  <td>{r.user}</td>
                  <td>{r.model}</td>
                  <td>{fmtTokens(r.total_tokens)}</td>
                  <td>{r.tool_calls_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>) : (subTab === "memories" ? <AgentMemoryPanel /> : <AgentInspectPanel />)}
    </div>
  )
}

/* ── Memory Panel ──────────────────────────────────────────────────────────── */

type MemoryItem = {
  id: number
  category: string
  key: string
  value: string
  created_at: string
  updated_at: string
}

function AgentMemoryPanel() {
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [filterCategory, setFilterCategory] = useState("")
  const [newKey, setNewKey] = useState("")
  const [newValue, setNewValue] = useState("")
  const [newCategory, setNewCategory] = useState("environment")
  const [saving, setSaving] = useState(false)

  const load = useCallback((q?: string, cat?: string) => {
    setLoading(true)
    const params = new URLSearchParams()
    if (q) params.set("q", q)
    if (cat) params.set("category", cat)
    const qs = params.toString()
    api<{ memories: MemoryItem[] }>(`/api/v1/agent/memories${qs ? "?" + qs : ""}`)
      .then(r => setMemories(r.memories))
      .catch(() => setMemories([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const handleSearch = () => {
    load(searchQuery || undefined, filterCategory || undefined)
  }

  const handleSave = async () => {
    if (!newKey.trim() || !newValue.trim()) return
    setSaving(true)
    try {
      await api("/api/v1/agent/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newKey, value: newValue, category: newCategory }),
      })
      setNewKey("")
      setNewValue("")
      load()
    } catch (e) {
      console.error("Save memory failed:", e)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await api(`/api/v1/agent/memories/${id}`, { method: "DELETE" })
      load()
    } catch (e) {
      console.error("Delete memory failed:", e)
    }
  }

  if (loading) return <div className="usage-empty">載入中...</div>

  // Group by category
  const groups: Record<string, MemoryItem[]> = {}
  for (const m of memories) {
    groups[m.category] = groups[m.category] || []
    groups[m.category].push(m)
  }

  return (
    <div className="memory-panel">
      <div className="memory-header">
        <h3>🧠 記憶管理</h3>
        <p className="memory-desc">Agent 的跨對話記憶 — 重要事實會自動保留到下次對話</p>
      </div>

      {/* Search & filter */}
      <div className="memory-add" style={{ marginBottom: 8 }}>
        <input
          className="memory-input"
          placeholder="搜索記憶..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
        />
        <select className="memory-select" value={filterCategory} onChange={e => { setFilterCategory(e.target.value); load(searchQuery || undefined, e.target.value || undefined); }}>
          <option value="">全部分類</option>
          <option value="user">用戶</option>
          <option value="environment">環境</option>
          <option value="procedure">流程</option>
          <option value="preference">偏好</option>
        </select>
        <button className="memory-add-btn" onClick={handleSearch}>🔍 搜索</button>
        <button className="memory-add-btn" onClick={() => { setSearchQuery(""); setFilterCategory(""); load(); }} style={{ opacity: 0.7 }}>重置</button>
      </div>

      {/* Add new memory */}
      <div className="memory-add">
        <input
          className="memory-input"
          placeholder="鍵（如：preferred_language）"
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
        />
        <select className="memory-select" value={newCategory} onChange={e => setNewCategory(e.target.value)}>
          <option value="user">用戶</option>
          <option value="environment">環境</option>
          <option value="procedure">流程</option>
          <option value="preference">偏好</option>
        </select>
        <input
          className="memory-input"
          placeholder="值（如：繁體中文）"
          value={newValue}
          onChange={e => setNewValue(e.target.value)}
        />
        <button className="memory-add-btn" onClick={handleSave} disabled={saving}>
          {saving ? "儲存中..." : "＋ 新增"}
        </button>
      </div>

      {/* Memory list */}
      {Object.keys(groups).length === 0 ? (
        <div className="memory-empty">暫無記憶 — Agent 會在對話中自動學習並記憶重要資訊</div>
      ) : (
        Object.entries(groups).map(([cat, items]) => (
          <div key={cat} className="memory-group">
            <h4 className="memory-group-title">[{cat}]</h4>
            <div className="memory-list">
              {items.map(m => (
                <div key={m.id} className="memory-item">
                  <div className="memory-item-content">
                    <span className="memory-key">{m.key}</span>
                    <span className="memory-value">{m.value}</span>
                  </div>
                  <button className="memory-delete-btn" onClick={() => handleDelete(m.id)}>×</button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/* ── Inspect Panel ─────────────────────────────────────────────────────────── */

type InspectHost = { asset_id: string; name: string; cpu_percent: number | null; mem_percent: number | null; disk_percent: number | null }
type InspectService = { asset_id: string; name: string; services: { name: string; type: string; status: string }[] }
type InspectAlert = { id: number; severity: string; message: string; created_at: string }
type InspectReport = {
  timestamp: string
  hosts: InspectHost[]
  services: InspectService[]
  alerts: InspectAlert[]
  issues: string[]
  summary: string
  notes_created: string[]
}

function AgentInspectPanel() {
  const [report, setReport] = useState<InspectReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const runInspect = useCallback(() => {
    setLoading(true)
    setError("")
    api<InspectReport>("/api/v1/agent/inspect", { method: "POST", body: JSON.stringify({}) })
      .then(r => { setReport(r); setError("") })
      .catch(e => { setError(typeof e === 'string' ? e : '檢查失敗') })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { runInspect() }, [runInspect])

  const pctColor = (v: number | null) => {
    if (v === null) return "#888"
    if (v > 90) return "#ef4444"
    if (v > 75) return "#f59e0b"
    return "#22c55e"
  }

  const severityColor = (s: string) => {
    if (s === "critical") return "#ef4444"
    if (s === "high") return "#f97316"
    if (s === "medium") return "#f59e0b"
    return "#888"
  }

  return (
    <div className="usage-content">
      <div className="usage-header">
        <h3>🔍 系統健康檢查</h3>
        <button className="btn btn-secondary" onClick={runInspect} disabled={loading}>
          {loading ? "檢查中..." : "🔄 重新檢查"}
        </button>
      </div>

      {error && <div style={{ padding: "12px", background: "#fef2f2", color: "#dc2626", borderRadius: "6px", marginBottom: "12px" }}>⚠ {error}</div>}

      {loading && !report && <div className="usage-empty">系統檢查中...</div>}

      {report && (
        <>
          {/* Summary */}
          <div style={{ padding: "12px", background: "#f0fdf4", borderRadius: "6px", marginBottom: "12px" }}>
            <strong>📋 總結</strong>
            <p style={{ margin: "8px 0 0" }}>{report.summary || "檢查完成"}</p>
            {report.notes_created.length > 0 && (
              <p style={{ margin: "4px 0 0", color: "#dc2626" }}>📝 自動創建了 {report.notes_created.length} 筆筆記</p>
            )}
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#888" }}>檢查時間: {new Date(report.timestamp).toLocaleString('zh-TW')}</p>
          </div>

          {/* Hosts */}
          <div style={{ marginBottom: "12px" }}>
            <h4 style={{ margin: "0 0 8px" }}>🖥️ 主機監控 ({report.hosts.length})</h4>
            {report.hosts.map(h => (
              <div key={h.asset_id} style={{ padding: "8px", background: "#f9fafb", borderRadius: "6px", marginBottom: "4px" }}>
                <strong>{h.name}</strong>
                <div style={{ display: "flex", gap: "16px", marginTop: "4px" }}>
                  <span style={{ color: pctColor(h.cpu_percent) }}>CPU {h.cpu_percent ?? '?'}%</span>
                  <span style={{ color: pctColor(h.mem_percent) }}>記憶體 {h.mem_percent ?? '?'}%</span>
                  <span style={{ color: pctColor(h.disk_percent) }}>磁碟 {h.disk_percent ?? '?'}%</span>
                </div>
              </div>
            ))}
          </div>

          {/* Services */}
          <div style={{ marginBottom: "12px" }}>
            <h4 style={{ margin: "0 0 8px" }}>⚙️ 服務 ({report.services.length} 台主機)</h4>
            {report.services.map(s => (
              <div key={s.asset_id} style={{ padding: "8px", background: "#f9fafb", borderRadius: "6px", marginBottom: "4px" }}>
                <strong>{s.name}</strong>
                {s.services.length > 0 && (
                  <div style={{ marginTop: "4px" }}>
                    {s.services.map((svc, i) => (
                      <div key={i} style={{ fontSize: "13px" }}>
                        <span>✅ {svc.name} ({svc.type})</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Alerts */}
          {report.alerts.length > 0 && (
            <div style={{ marginBottom: "12px" }}>
              <h4 style={{ margin: "0 0 8px" }}>🚨 未確認告警 ({report.alerts.length})</h4>
              {report.alerts.map(a => (
                <div key={a.id} style={{ padding: "8px", background: "#fef2f2", borderRadius: "6px", marginBottom: "4px", borderLeft: `3px solid ${severityColor(a.severity)}` }}>
                  <span style={{ fontWeight: "bold", color: severityColor(a.severity) }}>[{a.severity}]</span> {a.message}
                  <div style={{ fontSize: "12px", color: "#888", marginTop: "2px" }}>{new Date(a.created_at).toLocaleString('zh-TW')}</div>
                </div>
              ))}
            </div>
          )}

          {/* Issues */}
          {report.issues.length > 0 && (
            <div>
              <h4 style={{ margin: "0 0 8px" }}>⚠️ LLM 發現問題 ({report.issues.length})</h4>
              {report.issues.map((issue, i) => (
                <div key={i} style={{ padding: "8px", background: "#fef3c7", borderRadius: "6px", marginBottom: "4px" }}>
                  ⚠️ {issue}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}