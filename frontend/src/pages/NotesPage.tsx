import { useEffect, useState, useRef, useCallback } from "react"

/* ── Notes / Knowledge Base ──────────────────────────────────────────────────
   Frontend-only knowledge base using localStorage.
   Categories: 筆記 · 知識 · 貼文 · 待辦
   ─────────────────────────────────────────────────────────────────────────── */

type Category = "筆記" | "知識" | "貼文" | "待辦"

interface Note {
  id: string
  title: string
  category: Category
  content: string
  tags: string[]
  created: string
  updated: string
  pinned: boolean
}

const STORAGE_KEY = "ops-notes"
const CATEGORIES: Category[] = ["筆記", "知識", "貼文", "待辦"]

const categoryIcon: Record<Category, string> = {
  筆記: "📝",
  知識: "📚",
  貼文: "📢",
  待辦: "✅",
}

const categoryColor: Record<Category, string> = {
  筆記: "#3b82f6",
  知識: "#8b5cf6",
  貼文: "#f59e0b",
  待辦: "#22c55e",
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function loadNotes(): Note[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveNotes(notes: Note[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes))
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function stripHtml(html: string): string {
  const div = document.createElement("div")
  div.innerHTML = html
  return div.textContent || ""
}

/* ── Markdown-like preview (simple) ────────────────────────────────────────── */

function renderContent(text: string): string {
  let html = text
    // code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = code.replace(/</g, "&lt;").replace(/>/g, "&gt;")
      return `<pre style="background:#1a1b26;color:#c0caf5;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;font-family:monospace;margin:8px 0"><code>${escaped}</code></pre>`
    })
    // inline code
    .replace(/`([^`]+)`/g, '<code style="background:#1e293b;color:#7dcfff;padding:2px 6px;border-radius:3px;font-size:12px;font-family:monospace">$1</code>')
    // bold
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // italic
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // headings
    .replace(/^### (.+)$/gm, "<h4 style='font-size:14px;margin:12px 0 6px'>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3 style='font-size:16px;margin:14px 0 8px'>$1</h3>")
    .replace(/^# (.+)$/gm, "<h2 style='font-size:18px;margin:16px 0 10px'>$1</h2>")
    // lists
    .replace(/^- (.+)$/gm, "<li style='margin-left:20px;list-style:disc'>$1</li>")
    .replace(/^\d+\. (.+)$/gm, "<li style='margin-left:20px;list-style:decimal'>$1</li>")
    // links
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" style="color:var(--primary)">$1</a>')
    // line breaks
    .replace(/\n\n/g, "</p><p style='margin:6px 0'>")
    .replace(/\n/g, "<br>")

  return `<p style='margin:6px 0;line-height:1.7'>${html}</p>`
}

/* ── Editor Modal ──────────────────────────────────────────────────────────── */

function NoteEditor({
  note,
  onSave,
  onClose,
}: {
  note: Note | null
  onSave: (note: Note) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(note?.title ?? "")
  const [category, setCategory] = useState<Category>(note?.category ?? "筆記")
  const [content, setContent] = useState(note?.content ?? "")
  const [tagInput, setTagInput] = useState("")
  const [tags, setTags] = useState<string[]>(note?.tags ?? [])
  const [preview, setPreview] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const addTag = () => {
    const t = tagInput.trim()
    if (t && !tags.includes(t)) {
      setTags((prev) => [...prev, t])
      setTagInput("")
    }
  }

  const removeTag = (t: string) => setTags((prev) => prev.filter((x) => x !== t))

  const handleSave = () => {
    if (!title.trim()) return
    const now = new Date().toISOString()
    onSave({
      id: note?.id ?? uid(),
      title: title.trim(),
      category,
      content: content.trim(),
      tags,
      created: note?.created ?? now,
      updated: now,
      pinned: note?.pinned ?? false,
    })
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: "min(900px, 90vw)", maxHeight: "85vh", overflow: "auto", margin: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <h2>{note ? "編輯" : "新增"}{note ? ` — ${note.category}` : ""}</h2>
          <button className="btn btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="card-body">
          {/* Title */}
          <div style={{ marginBottom: 12 }}>
            <input
              type="text"
              placeholder="標題..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                fontSize: 16,
                fontWeight: 600,
                border: "1px solid var(--border)",
                borderRadius: 6,
                outline: "none",
              }}
            />
          </div>

          {/* Category + Tags row */}
          <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                fontSize: 13,
                outline: "none",
              }}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryIcon[c]} {c}
                </option>
              ))}
            </select>

            <div style={{ display: "flex", gap: 4, alignItems: "center", flex: 1 }}>
              <input
                type="text"
                placeholder="標籤 (Enter 新增)"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  fontSize: 12,
                  outline: "none",
                  minWidth: 120,
                }}
              />
              {tags.map((t) => (
                <span
                  key={t}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: "#f1f5f9",
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  {t}
                  <span
                    onClick={() => removeTag(t)}
                    style={{ cursor: "pointer", color: "var(--danger)" }}
                  >
                    ×
                  </span>
                </span>
              ))}
            </div>
          </div>

          {/* Editor toolbar */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              支援 Markdown 語法：# 標題 **粗體** *斜體* `程式碼` - 列表
            </span>
            <button
              className="btn btn-sm"
              onClick={() => setPreview(!preview)}
            >
              {preview ? "編輯" : "預覽"}
            </button>
          </div>

          {/* Content */}
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              minHeight: 300,
              overflow: "auto",
            }}
          >
            {preview ? (
              <div
                style={{ padding: 16, fontSize: 14, lineHeight: 1.7 }}
                dangerouslySetInnerHTML={{ __html: renderContent(content) }}
              />
            ) : (
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="開始寫..."
                style={{
                  width: "100%",
                  minHeight: 300,
                  padding: 16,
                  border: "none",
                  outline: "none",
                  resize: "vertical",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                  lineHeight: 1.7,
                  background: "transparent",
                }}
              />
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={!title.trim()}
            >
              {note ? "儲存" : "發布"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Note Card ─────────────────────────────────────────────────────────────── */

function NoteCard({
  note,
  onEdit,
  onDelete,
  onTogglePin,
}: {
  note: Note
  onEdit: () => void
  onDelete: () => void
  onTogglePin: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const preview = stripHtml(note.content).slice(0, 120)

  return (
    <div
      className="card"
      style={{
        cursor: "pointer",
        borderColor: note.pinned ? categoryColor[note.category] : undefined,
        boxShadow: note.pinned ? `0 0 0 1px ${categoryColor[note.category]}40` : undefined,
      }}
    >
      <div className="card-body" style={{ padding: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className="tag"
              style={{
                background: categoryColor[note.category] + "18",
                color: categoryColor[note.category],
              }}
            >
              {categoryIcon[note.category]} {note.category}
            </span>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{note.title}</h3>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin()
              }}
              title={note.pinned ? "取消置頂" : "置頂"}
              style={{ color: note.pinned ? "#f59e0b" : undefined }}
            >
              {note.pinned ? "★" : "☆"}
            </button>
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
              title="編輯"
            >
              ✎
            </button>
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
              title="刪除"
              style={{ color: "var(--danger)" }}
            >
              🗑
            </button>
          </div>
        </div>

        {/* Tags */}
        {note.tags.length > 0 && (
          <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
            {note.tags.map((t) => (
              <span key={t} className="tag" style={{ fontSize: 10 }}>
                #{t}
              </span>
            ))}
          </div>
        )}

        {/* Content preview */}
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
            maxHeight: expanded ? "none" : 60,
            overflow: "hidden",
          }}
        >
          {expanded ? (
            <div dangerouslySetInnerHTML={{ __html: renderContent(note.content) }} />
          ) : (
            <p style={{ margin: 0 }}>{preview}{note.content.length > 120 ? "…" : ""}</p>
          )}
        </div>

        {note.content.length > 120 && (
          <div
            onClick={() => setExpanded(!expanded)}
            style={{
              fontSize: 12,
              color: "var(--primary)",
              cursor: "pointer",
              marginTop: 4,
            }}
          >
            {expanded ? "收起" : "展開"}
          </div>
        )}

        <div
          style={{
            fontSize: 11,
            color: "#94a3b8",
            marginTop: 8,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>建立 {formatDate(note.created)}</span>
          <span>更新 {formatDate(note.updated)}</span>
        </div>
      </div>
    </div>
  )
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */

export function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [filter, setFilter] = useState<Category | "全部">("全部")
  const [search, setSearch] = useState("")
  const [editorNote, setEditorNote] = useState<Note | null>(null)
  const [showEditor, setShowEditor] = useState(false)

  useEffect(() => {
    setNotes(loadNotes())
  }, [])

  const persist = useCallback((updated: Note[]) => {
    setNotes(updated)
    saveNotes(updated)
  }, [])

  const handleSave = (note: Note) => {
    persist(notes.map((n) => (n.id === note.id ? note : n)).concat(notes.find((n) => n.id === note.id) ? [] : [note]))
    setShowEditor(false)
    setEditorNote(null)
  }

  const handleDelete = (id: string) => {
    if (confirm("確定刪除此筆記？")) {
      persist(notes.filter((n) => n.id !== id))
    }
  }

  const handleTogglePin = (id: string) => {
    persist(
      notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n))
    )
  }

  const openNew = () => {
    setEditorNote(null)
    setShowEditor(true)
  }

  const openEdit = (note: Note) => {
    setEditorNote(note)
    setShowEditor(true)
  }

  // Filter + search
  const filtered = notes
    .filter((n) => filter === "全部" || n.category === filter)
    .filter(
      (n) =>
        !search ||
        n.title.toLowerCase().includes(search.toLowerCase()) ||
        n.content.toLowerCase().includes(search.toLowerCase()) ||
        n.tags.some((t) => t.includes(search))
    )
    .sort((a, b) => {
      // Pinned first
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      // Then by updated desc
      return b.updated.localeCompare(a.updated)
    })

  // Category counts
  const counts: Record<string, number> = { 全部: notes.length }
  CATEGORIES.forEach((c) => {
    counts[c] = notes.filter((n) => n.category === c).length
  })

  return (
    <>
      <div className="page-header">
        <div>
          <h1>筆記</h1>
          <p>知識管理 · 貼文 · 待辦</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>
          ＋ 新增
        </button>
      </div>

      {/* Stats */}
      <div className="stats-row" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">總數</div>
          <div className="stat-value">{notes.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">筆記</div>
          <div className="stat-value" style={{ color: categoryColor["筆記"] }}>
            {counts["筆記"] ?? 0}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">知識</div>
          <div className="stat-value" style={{ color: categoryColor["知識"] }}>
            {counts["知識"] ?? 0}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">待辦</div>
          <div className="stat-value" style={{ color: categoryColor["待辦"] }}>
            {counts["待辦"] ?? 0}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="filters">
        <input
          className="search-input"
          type="text"
          placeholder="搜尋標題、內容、標籤..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {(["全部", ...CATEGORIES] as const).map((c) => (
          <button
            key={c}
            className="btn btn-sm"
            onClick={() => setFilter(c)}
            style={
              filter === c
                ? {
                    background: "var(--primary)",
                    color: "#fff",
                    borderColor: "var(--primary)",
                  }
                : {}
            }
          >
            {c !== "全部" && categoryIcon[c]} {c} ({counts[c] ?? 0})
          </button>
        ))}
      </div>

      {/* Notes list */}
      {filtered.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📝</div>
            <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
              {notes.length === 0
                ? "還沒有筆記，點擊「＋ 新增」開始"
                : "沒有符合的筆記"}
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(400px, 1fr))",
            gap: 16,
          }}
        >
          {filtered.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onEdit={() => openEdit(note)}
              onDelete={() => handleDelete(note.id)}
              onTogglePin={() => handleTogglePin(note.id)}
            />
          ))}
        </div>
      )}

      {/* Editor modal */}
      {showEditor && (
        <NoteEditor
          note={editorNote}
          onSave={handleSave}
          onClose={() => {
            setShowEditor(false)
            setEditorNote(null)
          }}
        />
      )}
    </>
  )
}
