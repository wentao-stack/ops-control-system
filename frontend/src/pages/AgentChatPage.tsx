import { useEffect, useRef, useState, useCallback } from "react"
import { api } from "../auth"
import { AgentConversation, AgentMessage, fmtRel } from "../types"

const SUGGESTIONS = [
  "各主機監控狀況如何？",
  "有哪些服務在運行？",
  "最近有什麼告警？",
  "列出所有資產",
]

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
      <div
        className="agent-msg-bubble"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
      />
    </div>
  )
}

/* ── main page ───────────────────────────────────────────────────────────── */

export function AgentChatPage() {
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [llmReady, setLlmReady] = useState(true)
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
    const convId = activeId

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
                    if (!activeId) handleNew()
                    setTimeout(() => handleSend(s), 100)
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
                disabled={!input.trim() || !activeId}
                title="發送"
              >
                ▶
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
