import { useEffect, useRef, useState, useCallback } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api } from "../auth"
import { useTranslation } from "react-i18next"
import { AgentConversation, AgentMessage, fmtRel } from "../types"

const SUGGESTIONS_KEY = ["suggestion1", "suggestion2", "suggestion3", "suggestion4"] as const

type PendingConfirm = {
  confirm_id: string
  name: string
  parameters: Record<string, any>
  level?: string
}

type AgentHealth = {
  status: "ok" | "error"
  model: string
  message: string
}

/* ── SSE Event Bus Types ─────────────────────────────────────────────────── */

type SSEEvent =
  | { event: "conv_id"; conv_id: string }
  | { event: "thinking"; text: string }
  | { event: "token"; token: string }
  | { event: "tool_call"; id: string; name: string; params: Record<string, any>; level: string }
  | { event: "tool_progress"; id: string; message: string; percent: number }
  | { event: "tool_result"; id: string; name: string; result: string; duration_ms: number }
  | { event: "confirm"; id: string; name: string; params: Record<string, any>; level: string; message: string }
  | { event: "confirm_result"; id: string; approved: boolean }
  | { event: "error"; message: string; code: string }
  | { event: "warning"; message: string }
  | { event: "usage"; prompt_tokens: number; completion_tokens: number; total_tokens: number; tool_calls: number }
  | { event: "done" }

type ToolCardState = {
  id: string
  name: string
  params: Record<string, any>
  level: string
  status: "calling" | "progress" | "done" | "error"
  progress_msg?: string
  progress_pct?: number
  result?: string
  duration_ms?: number
}

type ToastState = {
  id: string
  type: "error" | "warning" | "info"
  message: string
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function groupConversations(convs: AgentConversation[], t: (key: string) => string): Map<string, AgentConversation[]> {
  const groups = new Map<string, AgentConversation[]>()
  const now = Date.now()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = todayStart.getTime() - 86_400_000

  for (const c of convs) {
    const updatedAt = new Date(c.updated_at).getTime()
    let label: string
    if (!Number.isFinite(updatedAt) || updatedAt > now) label = t("agent.today")
    else if (updatedAt >= todayStart.getTime()) label = t("agent.today")
    else if (updatedAt >= yesterdayStart) label = t("agent.yesterday")
    else label = t("agent.earlier")
    groups.set(label, [...(groups.get(label) ?? []), c])
  }
  // ensure ordering
  const ordered = new Map<string, AgentConversation[]>()
  for (const key of [t("agent.today"), t("agent.yesterday"), t("agent.earlier")]) {
    if (groups.has(key)) ordered.set(key, groups.get(key)!)
  }
  return ordered
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function formatToolInput(value: string | null): string {
  if (!value) return ""
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return Object.entries(parsed).map(([key, item]) => `${key}=${String(item)}`).join(" ")
  } catch {
    return value
  }
}

function PaginationControls({
  offset,
  limit,
  total,
  onPage,
  compact = false,
  t,
}: {
  offset: number
  limit: number
  total: number
  onPage: (offset: number) => void
  compact?: boolean
  t?: (key: string) => string
}) {
  if (total <= limit) return null
  const page = Math.floor(offset / limit) + 1
  const pages = Math.ceil(total / limit)
  const tk = t ?? ((k: string, _?: Record<string, unknown>) => k)
  return (
    <nav className={`agent-pagination${compact ? " compact" : ""}`} aria-label={tk("agent.paginationLabel")}>
      <span>{offset + 1}–{Math.min(offset + limit, total)} / {total}</span>
      <button type="button" onClick={() => onPage(Math.max(0, offset - limit))} disabled={offset === 0}>{tk("agent.prevPage")}</button>
      <span>{tk("agent.pageOf", { page, pages })}</span>
      <button type="button" onClick={() => onPage(offset + limit)} disabled={offset + limit >= total}>{tk("agent.nextPage")}</button>
    </nav>
  )
}

/* ── sub-components (inline) ─────────────────────────────────────────────── */

function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  disabled,
  deletingId,
  mobileOpen,
  onClose,
  loading,
  error,
  onRetry,
  total,
  offset,
  limit,
  onPage,
  t,
}: {
  conversations: AgentConversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  disabled: boolean
  deletingId: string | null
  mobileOpen: boolean
  onClose: () => void
  loading: boolean
  error: string
  onRetry: () => void
  total: number
  offset: number
  limit: number
  onPage: (offset: number) => void
  t: (key: string) => string
}) {
  const groups = groupConversations(conversations, t)

  return (
    <aside className={`agent-sidebar${mobileOpen ? " mobile-open" : ""}`} aria-label={t("agent.closeHistory")}>
      <div className="agent-sidebar-header">
        <button className="btn btn-primary" style={{ width: "100%" }} onClick={onNew} disabled={disabled}>
          {t("agent.newConversation")}
        </button>
        <button className="agent-sidebar-close" onClick={onClose} aria-label={t("agent.closeHistory")}>×</button>
      </div>
      <div className="agent-sidebar-list">
        {Array.from(groups.entries()).map(([label, convs]) => (
          <div key={label}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", padding: "8px 12px 4px", textTransform: "uppercase", letterSpacing: 0.5 }}>
              {label}
            </div>
            {convs.map(c => (
              <div key={c.id} className={`agent-chat-item${c.id === activeId ? " active" : ""}`}>
                <button
                  type="button"
                  className="agent-chat-select"
                  onClick={() => { onSelect(c.id); onClose() }}
                  disabled={disabled}
                >
                  <span className="agent-chat-item-title">{c.title}</span>
                  <span className="agent-chat-item-time">{fmtRel(c.updated_at)}</span>
                </button>
                <button
                  type="button"
                  className="agent-chat-delete"
                  aria-label={`${t("agent.deleteConversation")} ${c.title}`}
                  title={t("agent.deleteConversation")}
                  onClick={() => onDelete(c.id)}
                  disabled={disabled || deletingId === c.id}
                >
                  {deletingId === c.id ? "…" : "×"}
                </button>
              </div>
            ))}
          </div>
        ))}
        {loading && <div className="agent-sidebar-state">{t("agent.loadingHistory")}</div>}
        {!loading && error && (
          <div className="agent-sidebar-state agent-sidebar-error">
            <span>{error}</span>
            <button type="button" onClick={onRetry}>{t("agent.retry")}</button>
          </div>
        )}
        {!loading && !error && conversations.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--text-secondary)" }}>
            {t("agent.noHistory")}
          </div>
        )}
      </div>
      {!loading && !error && <PaginationControls compact total={total} offset={offset} limit={limit} onPage={onPage} t={t} />}
    </aside>
  )
}

function MessageBubble({ msg, t }: { msg: AgentMessage; t: (key: string) => string }) {
  const isUser = msg.role === "user"
  const isTool = msg.role === "tool"

  if (isTool && msg.tool_name) {
    return (
      <div className="agent-tool-card">
        <div className="agent-tool-header">
          <span>⚙</span>
          <span>{msg.tool_name}</span>
          {msg.tool_input && (
            <span className="agent-tool-params">{formatToolInput(msg.tool_input)}</span>
          )}
        </div>
        {msg.tool_result && (
          <details className="agent-tool-details" open>
            <summary>{t("agent.fullToolResult")}</summary>
            <pre className="agent-tool-body">{msg.tool_result}</pre>
          </details>
        )}
      </div>
    )
  }

  return (
    <div className={`agent-msg ${isUser ? "user" : "assistant"}`}>
      <div className="agent-msg-avatar">{isUser ? "👤" : "🤖"}</div>
      <div className="agent-msg-content">
        <div className="agent-msg-bubble">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        </div>
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
  const { t, i18n } = useTranslation()

  const [tab, setTab] = useState<"chat" | "usage">("chat")
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [conversationsLoading, setConversationsLoading] = useState(true)
  const [conversationsError, setConversationsError] = useState("")
  const [conversationsTotal, setConversationsTotal] = useState(0)
  const [conversationOffset, setConversationOffset] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState("")
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [toolCards, setToolCards] = useState<ToolCardState[]>([])
  const [toasts, setToasts] = useState<ToastState[]>([])
  const [health, setHealth] = useState<AgentHealth | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messageRequestRef = useRef(0)
  const temporaryIdRef = useRef(-1)
  const toastIdRef = useRef(0)

  const pushToast = useCallback((type: ToastState["type"], message: string) => {
    const id = `toast-${Date.now()}-${toastIdRef.current++}`
    setToasts(prev => [...prev, { id, type, message }])
  }, [])

  /* load conversations */
  const loadConversations = useCallback(async (offset = 0) => {
    setConversationsLoading(true)
    setConversationsError("")
    try {
      const response = await api<{ conversations: AgentConversation[]; total: number }>(`/api/v1/agent/conversations?limit=50&offset=${offset}`)
      setConversations(response.conversations)
      setConversationsTotal(response.total)
      setConversationOffset(offset)
    } catch (error) {
      setConversationsError(errorMessage(error, t("agent.loadConversationsFailed")))
    } finally {
      setConversationsLoading(false)
    }
  }, [])

  /* load messages for a conversation */
  const loadMessages = useCallback(async (convId: string, beforeId?: number) => {
    const requestId = ++messageRequestRef.current
    if (beforeId) setLoadingOlderMessages(true)
    else setMessagesLoading(true)
    setMessagesError("")
    try {
      const query = beforeId ? `?limit=100&before_id=${beforeId}` : "?limit=100"
      const response = await api<{ messages: AgentMessage[]; has_more: boolean }>(`/api/v1/agent/conversations/${encodeURIComponent(convId)}/messages${query}`)
      if (messageRequestRef.current === requestId) {
        setMessages(prev => beforeId ? [...response.messages, ...prev] : response.messages)
        setHasMoreMessages(response.has_more)
      }
    } catch (error) {
      if (messageRequestRef.current === requestId) {
        setMessagesError(errorMessage(error, t("agent.loadMessagesFailed")))
      }
    } finally {
      if (messageRequestRef.current === requestId) {
        setMessagesLoading(false)
        setLoadingOlderMessages(false)
      }
    }
  }, [])

  /* check LLM health */
  const checkHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      setHealth(await api<AgentHealth>("/api/v1/agent/health"))
    } catch (error) {
      setHealth({ status: "error", model: "", message: errorMessage(error, t("agent.checkModelFailed")) })
    } finally {
      setHealthLoading(false)
    }
  }, [])

  /* initial load */
  useEffect(() => {
    loadConversations(0)
    checkHealth()
  }, [checkHealth, loadConversations])

  useEffect(() => () => abortRef.current?.abort(), [])

  /* scroll to bottom on new messages */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, thinking, toolCards])

  /* auto-resize textarea */
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = "auto"
      el.style.height = Math.min(el.scrollHeight, 120) + "px"
    }
  }, [input])

  /* toast auto-dismiss */
  useEffect(() => {
    if (toasts.length === 0) return
    const timer = setTimeout(() => setToasts(prev => prev.slice(1)), 5000)
    return () => clearTimeout(timer)
  }, [toasts])

  /* Start locally; the backend creates the conversation with the first message. */
  const handleNew = () => {
    if (streaming) return
    messageRequestRef.current += 1
    setActiveId(null)
    setMessages([])
    setMessagesError("")
    setMessagesLoading(false)
    setHasMoreMessages(false)
    setToolCards([])
    setPendingConfirm(null)
    setMobileSidebarOpen(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  /* delete conversation */
  const handleDelete = async (id: string) => {
    if (streaming || deletingId) return
    const conversation = conversations.find(item => item.id === id)
    if (!window.confirm(t("agent.deleteConversationConfirm", { title: conversation?.title ?? t("agent.unnamedConversation") }))) return
    setDeletingId(id)
    try {
      await api(`/api/v1/agent/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
      setConversations(prev => prev.filter(c => c.id !== id))
      if (activeId === id) handleNew()
    } catch (error) {
      pushToast("error", errorMessage(error, t("agent.deleteConversationFailed")))
    } finally {
      setDeletingId(null)
    }
  }

  /* select conversation */
  const handleSelect = (id: string) => {
    if (streaming || id === activeId) return
    setActiveId(id)
    setMessages([])
    setHasMoreMessages(false)
    loadMessages(id)
  }

  /* send message with SSE streaming */
  const handleSend = async (text?: string) => {
    const message = (text ?? input).trim()
    if (!message || streaming || health?.status !== "ok") return

    setInput("")
    let convId = activeId
    setStreaming(true)
    setThinking(true)
    setMessagesError("")
    setToolCards([])

    // optimistically add user message
    const userId = temporaryIdRef.current--
    const assistantId = temporaryIdRef.current--
    const userMsg: AgentMessage = {
      id: userId,
      conversation_id: convId ?? "",
      role: "user",
      content: message,
      tool_name: null,
      tool_input: null,
      tool_result: null,
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])

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

    const abortCtrl = new AbortController()
    abortRef.current = abortCtrl
    const cards = new Map<string, ToolCardState>()
    let toolsFinalized = false
    let receivedDone = false
    let receivedError = false

    const updateCard = (id: string, update: Partial<ToolCardState>) => {
      const current = cards.get(id)
      if (!current) return
      const next = { ...current, ...update }
      cards.set(id, next)
      setToolCards(Array.from(cards.values()))
    }

    const finalizeTools = () => {
      if (toolsFinalized) return
      toolsFinalized = true
      const toolMessages = Array.from(cards.values())
        .filter(card => card.result !== undefined)
        .map((card): AgentMessage => ({
          id: temporaryIdRef.current--,
          conversation_id: convId ?? "",
          role: "tool",
          content: "",
          tool_name: card.name,
          tool_input: JSON.stringify(card.params),
          tool_result: card.result ?? "",
          created_at: new Date().toISOString(),
        }))
      if (toolMessages.length) {
        setMessages(prev => {
          const assistantIndex = prev.findIndex(item => item.id === assistantId)
          if (assistantIndex < 0) return [...prev, ...toolMessages]
          return [
            ...prev.slice(0, assistantIndex),
            ...toolMessages,
            prev[assistantIndex],
            ...prev.slice(assistantIndex + 1),
          ]
        })
      }
      setToolCards([])
    }

    const appendAssistantText = (content: string) => {
      setMessages(prev => prev.map(item => item.id === assistantId ? { ...item, content: item.content + content } : item))
    }

    const handleEventData = (data: string) => {
      if (!data || data === "[DONE]") return
      let parsed: SSEEvent
      try {
        parsed = JSON.parse(data) as SSEEvent
      } catch {
        appendAssistantText(data)
        return
      }

      switch (parsed.event) {
        case "conv_id":
          convId = parsed.conv_id
          setActiveId(parsed.conv_id)
          setMessages(prev => prev.map(item =>
            item.id === userId || item.id === assistantId
              ? { ...item, conversation_id: parsed.conv_id }
              : item
          ))
          break
        case "thinking":
          setThinking(true)
          break
        case "token":
          setThinking(false)
          appendAssistantText(parsed.token ?? "")
          break
        case "tool_call": {
          const card: ToolCardState = {
            id: parsed.id,
            name: parsed.name,
            params: parsed.params ?? {},
            level: parsed.level,
            status: "calling",
          }
          cards.set(card.id, card)
          setToolCards(Array.from(cards.values()))
          break
        }
        case "tool_progress":
          updateCard(parsed.id, {
            status: parsed.percent >= 100 ? "done" : "progress",
            progress_msg: parsed.message,
            progress_pct: Math.max(0, Math.min(100, parsed.percent)),
          })
          break
        case "tool_result":
          updateCard(parsed.id, { status: "done", result: parsed.result, duration_ms: parsed.duration_ms })
          break
        case "confirm":
          setPendingConfirm({
            confirm_id: parsed.id,
            name: parsed.name,
            parameters: parsed.params ?? {},
            level: parsed.level,
          })
          break
        case "confirm_result":
          setPendingConfirm(current => current?.confirm_id === parsed.id ? null : current)
          break
        case "error":
          receivedError = true
          setThinking(false)
          pushToast("error", parsed.message)
          setMessages(prev => prev.map(item =>
            item.id === assistantId && !item.content
              ? { ...item, content: `⚠ ${parsed.message}` }
              : item
          ))
          break
        case "warning":
          pushToast("warning", parsed.message)
          break
        case "usage":
          setMessages(prev => prev.map(item => item.id === assistantId ? { ...item, usage: parsed } : item))
          break
        case "done":
          receivedDone = true
          setThinking(false)
          finalizeTools()
          break
      }
    }

    const consumeBuffer = (rawBuffer: string, flush = false): string => {
      let buffer = rawBuffer.replace(/\r\n/g, "\n")
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block.split("\n")
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart())
          .join("\n")
        handleEventData(data)
        boundary = buffer.indexOf("\n\n")
      }
      if (flush && buffer.trim()) {
        const data = buffer.split("\n")
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart())
          .join("\n")
        handleEventData(data)
        return ""
      }
      return buffer
    }

    try {
      const body = JSON.stringify({
        conversation_id: convId,
        message,
        locale: i18n.resolvedLanguage || i18n.language,
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
      if (!reader) throw new Error(t("agent.streamNotReadable"))
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = consumeBuffer(buffer)
      }
      buffer += decoder.decode()
      consumeBuffer(buffer, true)
      if (!receivedDone) finalizeTools()
    } catch (error) {
      finalizeTools()
      if (error instanceof DOMException && error.name === "AbortError") {
        setMessages(prev => prev.map(item =>
          item.id === assistantId && !item.content ? { ...item, content: t("agent.stoppedGenerating") } : item
        ))
      } else {
        const messageText = errorMessage(error, t("agent.unknownError"))
        pushToast("error", t("agent.requestFailed", { detail: messageText }))
        setMessages(prev => prev.map(item =>
          item.id === assistantId ? { ...item, content: item.content || `⚠ ${t("agent.requestFailed", { detail: messageText })}` } : item
        ))
      }
    } finally {
      setStreaming(false)
      setThinking(false)
      setToolCards([])
      setPendingConfirm(null)
      abortRef.current = null
      loadConversations(0)
      if (receivedError) checkHealth()
    }
  }

  /* stop streaming */
  const handleStop = () => {
    if (pendingConfirm) {
      api("/api/v1/agent/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_id: pendingConfirm.confirm_id, approved: false }),
      }).catch(() => undefined)
    }
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
      setPendingConfirm(null)
    } catch (error) {
      pushToast("error", errorMessage(error, t("agent.confirmFailed")))
    } finally {
      setConfirming(false)
    }
  }

  /* handle keyboard */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div className="agent-chat">
      {/* Tab switcher */}
      <div className="agent-tabs">
        <button className={`agent-tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>{t("agent.chatTab")}</button>
        <button className={`agent-tab ${tab === "usage" ? "active" : ""}`} onClick={() => setTab("usage")}>{t("agent.adminTab")}</button>
        <span className={`agent-health-pill ${healthLoading ? "loading" : health?.status ?? "error"}`}>
          <span aria-hidden="true" />
          {healthLoading ? t("agent.checkingModel") : health?.status === "ok" ? health.model : t("agent.modelOffline")}
        </span>
      </div>

      {tab === "chat" ? (
      <div className="agent-chat-body">
      {mobileSidebarOpen && <button className="agent-sidebar-backdrop" aria-label={t("agent.closeHistory")} onClick={() => setMobileSidebarOpen(false)} />}
      {/* Sidebar */}
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        disabled={streaming}
        deletingId={deletingId}
        mobileOpen={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
        loading={conversationsLoading}
        error={conversationsError}
        onRetry={loadConversations}
        total={conversationsTotal}
        offset={conversationOffset}
        limit={50}
        onPage={loadConversations}
        t={t}
      />

      {/* Main chat area */}
      <div className="agent-main">
        <div className="agent-mobile-toolbar">
          <button type="button" onClick={() => setMobileSidebarOpen(true)}>{t("agent.mobileHistory")}</button>
          <button type="button" onClick={handleNew} disabled={streaming}>{t("agent.newConversation")}</button>
        </div>

        {!healthLoading && health?.status === "error" && (
          <div className="agent-health-banner" role="alert">
            <div>
              <strong>{t("agent.modelUnavailable")}</strong>
              <span>{health.message}</span>
            </div>
            <button type="button" onClick={checkHealth} disabled={healthLoading}>{t("agent.recheck")}</button>
          </div>
        )}

        {/* Messages */}
        <div className="agent-messages">
          {messagesLoading && <div className="agent-page-state">{t("agent.loadingConversation")}</div>}
          {!messagesLoading && messagesError && (
            <div className="agent-page-state agent-page-error">
              <span>{messagesError}</span>
              {activeId && <button type="button" onClick={() => loadMessages(activeId)}>{t("agent.retry")}</button>}
            </div>
          )}
          {!messagesLoading && !messagesError && !activeId && messages.length === 0 && (
            <div className="agent-empty">
              <div className="agent-empty-icon">🤖</div>
              <h3>{t("agent.aiAssistant")}</h3>
              <p>{t("agent.aiAssistantDesc")}</p>
              <div className="agent-suggestions">
                {SUGGESTIONS_KEY.map(k => (
                  <button
                    key={k}
                    className="agent-suggestion"
                    disabled={streaming || health?.status !== "ok"}
                    onClick={() => handleSend(t(`agent.${k}`))}
                  >
                    {t(`agent.${k}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasMoreMessages && activeId && (
            <button
              type="button"
              className="agent-load-older"
              disabled={loadingOlderMessages || messages.length === 0}
              onClick={() => loadMessages(activeId, messages[0]?.id)}
            >
              {loadingOlderMessages ? t("agent.loadingOlderMessages") : t("agent.loadOlderMessages")}
            </button>
          )}

          {!messagesLoading && messages.map(msg =>
            msg.role === "assistant" && !msg.content && streaming
              ? null
              : <MessageBubble key={msg.id} msg={msg} t={t} />
          )}

          {/* Tool execution cards (SSE event bus) */}
          {toolCards.map(card => (
            <div key={card.id} className={`agent-tool-exec agent-tool-exec-${card.status}`}>
              <div className="agent-tool-exec-header">
                <span className="agent-tool-exec-icon">
                  {card.status === "calling" && "⚡"}
                  {card.status === "progress" && "⏳"}
                  {card.status === "done" && "✅"}
                  {card.status === "error" && "❌"}
                </span>
                <span className="agent-tool-exec-name">{card.name}</span>
                <span className={`agent-tool-exec-level agent-level-${card.level}`}>{card.level}</span>
                {card.duration_ms !== undefined && card.status === "done" && (
                  <span className="agent-tool-exec-duration">{card.duration_ms}ms</span>
                )}
              </div>
              {card.status === "progress" && card.progress_msg && (
                <div className="agent-tool-exec-progress">
                  <div className="agent-tool-exec-progress-bar">
                    <div className="agent-tool-exec-progress-fill" style={{ width: `${card.progress_pct}%` }} />
                  </div>
                  <span className="agent-tool-exec-progress-text">{card.progress_msg}</span>
                </div>
              )}
              {card.status === "done" && card.result && (
                <details className="agent-tool-details" open>
                  <summary>{t("agent.fullToolResult")}</summary>
                  <pre className="agent-tool-exec-result">{card.result}</pre>
                </details>
              )}
            </div>
          ))}

          {/* Thinking indicator */}
          {thinking && (
            <div className="agent-thinking">
              <div className="agent-thinking-dots">
                <span>.</span><span>.</span><span>.</span>
              </div>
              <span className="agent-thinking-text">{t("agent.thinking")}</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Confirmation card */}
        {pendingConfirm && (
          <div className="agent-confirm-overlay">
            <div className="agent-confirm-card">
              <div className="agent-confirm-header">
                <span className="agent-confirm-icon">⚠️</span>
                <span className="agent-confirm-title">{t("agent.confirmAction")}</span>
              </div>
              <div className="agent-confirm-body">
                <div className="agent-confirm-tool">
                  <strong>{t("agent.tool")}:</strong> {pendingConfirm.name}
                </div>
                {pendingConfirm.name === "execute_runbook_step" ? (
                  <div className="agent-confirm-params agent-runbook-execution-plan">
                    <strong>📖 {t("agent.runbookExecution")}</strong>
                    <dl>
                      <div><dt>{t("agent.runbook")}</dt><dd>#{String(pendingConfirm.parameters.runbook_id ?? "—")}</dd></div>
                      <div><dt>{t("agent.step")}</dt><dd>{String(pendingConfirm.parameters.step_name ?? "—")}</dd></div>
                      <div><dt>{t("agent.target")}</dt><dd>{String(pendingConfirm.parameters.asset_id ?? "—")}</dd></div>
                      <div><dt>{t("agent.command")}</dt><dd><code>{String(pendingConfirm.parameters.command ?? "—")}</code></dd></div>
                    </dl>
                    <p>{t("agent.auditNotice")}</p>
                  </div>
                ) : (
                  <div className="agent-confirm-params">
                    <strong>{t("agent.params")}:</strong>
                    <pre>{JSON.stringify(pendingConfirm.parameters, null, 2)}</pre>
                  </div>
                )}
                <div className={`agent-confirm-risk agent-confirm-risk-${pendingConfirm.level ?? "exec"}`}>
                  {pendingConfirm.level === "exec" && t("agent.riskHigh")}
                  {pendingConfirm.level === "write" && t("agent.riskMedium")}
                  {pendingConfirm.level === "read" && t("agent.riskLow")}
                </div>
                <div className="agent-confirm-warning">
                  {t("agent.confirmWarning")}
                </div>
              </div>
              <div className="agent-confirm-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => handleConfirmTool(false)}
                  disabled={confirming}
                >
                  {t("agent.cancel")}
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => handleConfirmTool(true)}
                  disabled={confirming}
                >
                  ✓ {confirming ? t("agent.executing") : t("agent.confirmExecute")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast notifications (SSE event bus) */}
        <div className="agent-toast-stack" aria-live="polite">
          {toasts.map(toast => (
            <div key={toast.id} className={`agent-toast agent-toast-${toast.type}`}>
              <span className="agent-toast-icon">
                {toast.type === "error" && "❌"}
                {toast.type === "warning" && "⚠️"}
                {toast.type === "info" && "ℹ️"}
              </span>
              <span className="agent-toast-message">{toast.message}</span>
              <button type="button" aria-label={t("agent.closeToast")} onClick={() => setToasts(prev => prev.filter(item => item.id !== toast.id))}>×</button>
            </div>
          ))}
        </div>

        {/* Input area */}
        <div className="agent-input-area">
          <div className="agent-input-wrapper">
            <textarea
              ref={textareaRef}
              className="agent-input-textarea"
              placeholder={t("agent.inputPlaceholder")}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={healthLoading || health?.status !== "ok"}
              maxLength={10000}
              rows={1}
            />
            {streaming ? (
              <button className="agent-stop-btn" onClick={handleStop} title={t("agent.stop")}>
                ■
              </button>
            ) : (
              <button
                className="agent-send-btn"
                onClick={() => handleSend()}
                disabled={!input.trim() || healthLoading || health?.status !== "ok"}
                title={t("agent.send")}
              >
                ▶
              </button>
            )}
          </div>
        </div>
      </div>
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
  records_total: number
  records_offset: number
  records_limit: number
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return n.toString()
}

function AgentUsagePanel() {
  const { t } = useTranslation()
  const [subTab, setSubTab] = useState<"usage" | "memories" | "inspect">("usage")
  const [data, setData] = useState<UsageData | null>(null)
  const [period, setPeriod] = useState("month")
  const [recordsOffset, setRecordsOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback((p: string, offset = 0) => {
    setLoading(true)
    setError("")
    api<UsageData>(`/api/v1/agent/usage?period=${p}&limit=25&offset=${offset}`)
      .then(r => setData(r))
      .catch(error => setError(errorMessage(error, t("agent.loadUsageFailed"))))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { setRecordsOffset(0); load(period, 0) }, [period, load])

  const maxTokens = Math.max(...(data?.daily ?? []).map(d => d.total_tokens), 1)

  return (
    <div className="usage-panel">
      {/* Sub-tab switcher */}
      <div className="usage-sub-tabs">
        <button className={`usage-sub-tab ${subTab === "usage" ? "active" : ""}`} onClick={() => setSubTab("usage")}>{t("agent.usageStats")}</button>
        <button className={`usage-sub-tab ${subTab === "memories" ? "active" : ""}`} onClick={() => setSubTab("memories")}>{t("agent.memoryManagement")}</button>
        <button className={`usage-sub-tab ${subTab === "inspect" ? "active" : ""}`} onClick={() => setSubTab("inspect")}>{t("agent.systemInspect")}</button>
      </div>

      {subTab === "usage" ? loading ? (
        <div className="usage-empty">{t("agent.loading")}</div>
      ) : error ? (
        <div className="usage-empty usage-error-state">
          <span>{error}</span>
          <button type="button" className="btn btn-secondary" onClick={() => load(period, recordsOffset)}>{t("agent.retry")}</button>
        </div>
      ) : data ? (
      <div className="usage-content">
      <div className="usage-header">
        <h3>{t("agent.tokenUsageStats")}</h3>
        <div className="usage-period">
          {(["today", "week", "month", "all"] as const).map(p => (
            <button
              key={p}
              className={`usage-period-btn ${period === p ? "active" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p === "today" ? t("agent.periodToday") : p === "week" ? t("agent.periodWeek") : p === "month" ? t("agent.periodMonth") : t("agent.periodAll")}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="usage-cards">
        <div className="usage-card">
          <div className="usage-card-value">{fmtTokens(data.total_tokens)}</div>
          <div className="usage-card-label">{t("agent.totalTokens")}</div>
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
          <div className="usage-card-label">{t("agent.requestCount")}</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-value">{data.total_tool_calls}</div>
          <div className="usage-card-label">{t("agent.toolCallCount")}</div>
        </div>
      </div>

      {/* Daily chart */}
      {data.daily.length > 0 && (
        <div className="usage-chart">
          <h4>{t("agent.dailyUsage")}</h4>
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
          <h4>{t("agent.userBreakdown")}</h4>
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t("agent.user")}</th>
                <th>{t("agent.tokenCount")}</th>
                <th>{t("agent.requestCountTable")}</th>
                <th>{t("agent.toolCalls")}</th>
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
          <h4>{t("agent.recentRecords")}</h4>
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t("agent.time")}</th>
                <th>{t("agent.user")}</th>
                <th>{t("agent.model")}</th>
                <th>{t("agent.token")}</th>
                <th>{t("agent.toolCalls")}</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map(r => (
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
          <PaginationControls
            total={data.records_total}
            offset={data.records_offset}
            limit={data.records_limit}
            onPage={offset => { setRecordsOffset(offset); load(period, offset) }}
          />
        </div>
      )}
      </div>) : (
        <div className="usage-empty">{t("agent.noUsageData")}</div>
      ) : (subTab === "memories" ? <AgentMemoryPanel /> : <AgentInspectPanel />)}
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
  const { t } = useTranslation()
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [filterCategory, setFilterCategory] = useState("")
  const [newKey, setNewKey] = useState("")
  const [newValue, setNewValue] = useState("")
  const [newCategory, setNewCategory] = useState("environment")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const pageSize = 25

  const load = useCallback((q?: string, cat?: string, pageOffset = 0) => {
    setLoading(true)
    setError("")
    const params = new URLSearchParams()
    if (q) params.set("q", q)
    if (cat) params.set("category", cat)
    params.set("limit", String(pageSize))
    params.set("offset", String(pageOffset))
    const qs = params.toString()
    api<{ memories: MemoryItem[]; total: number }>(`/api/v1/agent/memories${qs ? "?" + qs : ""}`)
      .then(r => { setMemories(r.memories); setTotal(r.total); setOffset(pageOffset) })
      .catch(error => setError(errorMessage(error, t("agent.loadMemoryFailed"))))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const handleSearch = () => {
    load(searchQuery || undefined, filterCategory || undefined, 0)
  }

  const handleSave = async () => {
    if (!newKey.trim() || !newValue.trim()) return
    setSaving(true)
    setError("")
    try {
      await api("/api/v1/agent/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newKey.trim(), value: newValue.trim(), category: newCategory }),
      })
      setNewKey("")
      setNewValue("")
      load(searchQuery || undefined, filterCategory || undefined, 0)
    } catch (error) {
      setError(errorMessage(error, t("agent.saveMemoryFailed")))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    const memory = memories.find(item => item.id === id)
    if (!window.confirm(t("agent.deleteConversationConfirm", { title: memory?.key ?? String(id) }))) return
    setError("")
    try {
      await api(`/api/v1/agent/memories/${id}`, { method: "DELETE" })
      setMemories(prev => prev.filter(item => item.id !== id))
    } catch (error) {
      setError(errorMessage(error, t("agent.deleteMemoryFailed")))
    }
  }

  if (loading) return <div className="usage-empty">{t("agent.loading")}</div>

  // Group by category
  const groups: Record<string, MemoryItem[]> = {}
  for (const m of memories) {
    groups[m.category] = groups[m.category] || []
    groups[m.category].push(m)
  }

  return (
    <div className="memory-panel">
      <div className="memory-header">
        <h3>{t("agent.memoryTitle")}</h3>
        <p className="memory-desc">{t("agent.memoryDesc")}</p>
      </div>

      {error && <div className="memory-error" role="alert">⚠ {error}</div>}

      {/* Search & filter */}
      <div className="memory-add" style={{ marginBottom: 8 }}>
        <input
          className="memory-input"
          placeholder={t("agent.searchMemory")}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
        />
        <select className="memory-select" value={filterCategory} onChange={e => { setFilterCategory(e.target.value); load(searchQuery || undefined, e.target.value || undefined, 0); }}>
          <option value="">{t("agent.allCategories")}</option>
          <option value="user">{t("agent.catUser")}</option>
          <option value="environment">{t("agent.catEnvironment")}</option>
          <option value="procedure">{t("agent.catProcedure")}</option>
          <option value="preference">{t("agent.catPreference")}</option>
        </select>
        <button className="memory-add-btn" onClick={handleSearch}>{t("agent.search")}</button>
        <button className="memory-add-btn" onClick={() => { setSearchQuery(""); setFilterCategory(""); load(undefined, undefined, 0); }} style={{ opacity: 0.7 }}>{t("agent.reset")}</button>
      </div>

      {/* Add new memory */}
      <div className="memory-add">
        <input
          className="memory-input"
          placeholder={t("agent.addMemoryKeyPlaceholder")}
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
        />
        <select className="memory-select" value={newCategory} onChange={e => setNewCategory(e.target.value)}>
          <option value="user">{t("agent.catUser")}</option>
          <option value="environment">{t("agent.catEnvironment")}</option>
          <option value="procedure">{t("agent.catProcedure")}</option>
          <option value="preference">{t("agent.catPreference")}</option>
        </select>
        <input
          className="memory-input"
          placeholder={t("agent.addMemoryValuePlaceholder")}
          value={newValue}
          onChange={e => setNewValue(e.target.value)}
        />
        <button className="memory-add-btn" onClick={handleSave} disabled={saving || !newKey.trim() || !newValue.trim()}>
          {saving ? t("agent.saving") : t("agent.addMemory")}
        </button>
      </div>

      {/* Memory list */}
      {Object.keys(groups).length === 0 ? (
        <div className="memory-empty">{t("agent.noMemory")}</div>
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
                  <button className="memory-delete-btn" title={t("agent.deleteMemoryItem", { key: m.key })} aria-label={t("agent.deleteMemoryItem", { key: m.key })} onClick={() => handleDelete(m.id)}>×</button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      <PaginationControls
        total={total}
        offset={offset}
        limit={pageSize}
        onPage={pageOffset => load(searchQuery || undefined, filterCategory || undefined, pageOffset)}
      />
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
  const { t } = useTranslation()
  const [report, setReport] = useState<InspectReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [createNotes, setCreateNotes] = useState(false)

  const runInspect = useCallback(() => {
    setLoading(true)
    setError("")
    api<InspectReport>("/api/v1/agent/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ create_notes: createNotes }),
    })
      .then(r => { setReport(r); setError("") })
      .catch(error => { setError(errorMessage(error, t("agent.inspectFailed"))) })
      .finally(() => setLoading(false))
  }, [createNotes])

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
        <h3>{t("agent.inspectTitle")}</h3>
        <div className="inspect-actions">
          <label>
            <input type="checkbox" checked={createNotes} onChange={event => setCreateNotes(event.target.checked)} disabled={loading} />
            {t("agent.createNotesForIssues")}
          </label>
          <button className="btn btn-secondary" onClick={runInspect} disabled={loading}>
            {loading ? t("agent.inspecting") : report ? t("agent.reinspect") : t("agent.startInspect")}
          </button>
        </div>
      </div>

      {error && <div style={{ padding: "12px", background: "#fef2f2", color: "#dc2626", borderRadius: "6px", marginBottom: "12px" }}>⚠ {error}</div>}

      {loading && !report && <div className="usage-empty">{t("agent.inspectingSystem")}</div>}

      {!loading && !report && !error && (
        <div className="inspect-empty">
          <span>🔍</span>
          <strong>{t("agent.noInspectYet")}</strong>
          <p>{t("agent.noInspectDesc")}</p>
          <button className="btn btn-primary" onClick={runInspect}>{t("agent.startInspect")}</button>
        </div>
      )}

      {report && (
        <>
          {/* Summary */}
          <div style={{ padding: "12px", background: "#f0fdf4", borderRadius: "6px", marginBottom: "12px" }}>
            <strong>{t("agent.summary")}</strong>
            <p style={{ margin: "8px 0 0" }}>{report.summary || t("agent.inspectComplete")}</p>
            {report.notes_created.length > 0 && (
              <p style={{ margin: "4px 0 0", color: "#dc2626" }}>📝 {t("agent.notesCreated", { count: report.notes_created.length })}</p>
            )}
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#888" }}>{t("agent.inspectTime")}: {new Date(report.timestamp).toLocaleString('zh-TW')}</p>
          </div>

          {/* Hosts */}
          <div style={{ marginBottom: "12px" }}>
            <h4 style={{ margin: "0 0 8px" }}>{t("agent.hostMonitoring", { count: report.hosts.length })}</h4>
            {report.hosts.map(h => (
              <div key={h.asset_id} style={{ padding: "8px", background: "#f9fafb", borderRadius: "6px", marginBottom: "4px" }}>
                <strong>{h.name}</strong>
                <div style={{ display: "flex", gap: "16px", marginTop: "4px" }}>
                  <span style={{ color: pctColor(h.cpu_percent) }}>CPU {h.cpu_percent ?? '?'}%</span>
                  <span style={{ color: pctColor(h.mem_percent) }}>{t("agent.memory")}: {h.mem_percent ?? '?'}%</span>
                  <span style={{ color: pctColor(h.disk_percent) }}>{t("agent.disk")}: {h.disk_percent ?? '?'}%</span>
                </div>
              </div>
            ))}
          </div>

          {/* Services */}
          <div style={{ marginBottom: "12px" }}>
            <h4 style={{ margin: "0 0 8px" }}>{t("agent.services", { count: report.services.length })}</h4>
            {report.services.map(s => (
              <div key={s.asset_id} style={{ padding: "8px", background: "#f9fafb", borderRadius: "6px", marginBottom: "4px" }}>
                <strong>{s.name}</strong>
                {s.services.length > 0 && (
                  <div style={{ marginTop: "4px" }}>
                    {s.services.map((svc, i) => (
                      <div key={i} style={{ fontSize: "13px" }}>
                        <span>{svc.status === "running" ? "✅" : "❌"} {svc.name} ({svc.type})</span>
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
              <h4 style={{ margin: "0 0 8px" }}>{t("agent.unacknowledgedAlerts", { count: report.alerts.length })}</h4>
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
              <h4 style={{ margin: "0 0 8px" }}>{t("agent.llmDetectedIssues", { count: report.issues.length })}</h4>
              {report.issues.map((issue, i) => (
                <div key={i} style={{ padding: "8px", background: "#fef3c7", borderRadius: "6px", marginBottom: "4px" }}>
                  ⚠️ {issue}
                </div>
              ))}
            </div>
          )}
          <details className="agent-raw-response">
            <summary>{t("agent.fullSystemData")}</summary>
            <pre>{JSON.stringify(report, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  )
}