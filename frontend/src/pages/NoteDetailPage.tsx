import { useEffect, useState, useCallback } from "react"
import { useNavigate, useParams } from "react-router-dom"

/* ── Note Detail Page ────────────────────────────────────────────────────────
   Full article view with edit / delete / back navigation.
   ─────────────────────────────────────────────────────────────────────────── */

type Category = "筆記" | "知識" | "貼文" | "待辦"

interface Note {
  id: string
  title: string
  category: Category
  content: string
  tags: string[]
  author: string
  pinned: boolean
  published: boolean
  version: number
  created_at: string
  updated_at: string
}

const API_BASE = "/api/v1"
const PAGE_SIZE = 10

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

/* ── API helpers ───────────────────────────────────────────────────────────── */

async function apiFetch(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    credentials: "include",
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function getNoteApi(id: string): Promise<Note> {
  return apiFetch(`/notes/${id}`)
}

async function updateNoteApi(id: string, data: Partial<Note>) {
  return apiFetch(`/notes/${id}`, { method: "PUT", body: JSON.stringify(data) })
}

async function deleteNoteApi(id: string) {
  return apiFetch(`/notes/${id}`, { method: "DELETE" })
}

async function listNotesApi(page: number, category?: string, search?: string): Promise<{ items: Note[]; total: number }> {
  const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
  if (category) params.set("category", category)
  if (search) params.set("search", search)
  const data = await apiFetch(`/notes?${params}`)
  return { items: data.items || [], total: data.total || 0 }
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function formatDate(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ── Markdown-like rendering ───────────────────────────────────────────────── */

function renderContent(text: string): string {
  let html = text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, __, code) => {
      const escaped = code.replace(/</g, "&lt;").replace(/>/g, "&gt;")
      return `<pre style="background:#1a1b26;color:#c0caf5;padding:16px;border-radius:8px;overflow-x:auto;font-size:13px;font-family:monospace;margin:12px 0;border:1px solid #2a2b36"><code>${escaped}</code></pre>`
    })
    .replace(/`([^`]+)`/g, '<code style="background:#1e293b;color:#7dcfff;padding:2px 8px;border-radius:4px;font-size:13px;font-family:monospace">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h4 style='font-size:15px;margin:14px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--border)'>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3 style='font-size:17px;margin:16px 0 10px'>$1</h3>")
    .replace(/^# (.+)$/gm, "<h2 style='font-size:20px;margin:18px 0 12px'>$1</h2>")
    .replace(/^> (.+)$/gm, "<blockquote style='border-left:3px solid var(--primary);padding-left:12px;color:var(--text-secondary);margin:8px 0'>$1</blockquote>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--primary);text-decoration:underline">$1</a>')
    .replace(/^\|(.+)\|$/gm, (m) => {
      // Table row
      const cells = m.split("|").filter((c) => c.trim())
      if (cells.every((c) => /^[\s\-:]+$/.test(c))) return '<hr style="border:none;border-top:1px solid var(--border);margin:4px 0">'
      return `<tr>${cells.map((c) => `<td style="padding:6px 12px;border:1px solid var(--border)">${c.trim()}</td>`).join("")}</tr>`
    })
    .replace(/^- (.+)$/gm, "<li style='margin-left:20px;list-style:disc'>$1</li>")
    .replace(/^\d+\. (.+)$/gm, "<li style='margin-left:20px;list-style:decimal'>$1</li>")
    .replace(/^- \[([ xX])\] (.+)$/gm, (_, check, label) => {
      const checked = check.toLowerCase() === "x"
      return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" disabled ${checked ? "checked" : ""} style="accent-color:var(--primary)"><span style="${checked ? "text-decoration:line-through;color:var(--text-secondary)" : ""}">${label}</span></label>`
    })
    .replace(/\n\n/g, "</p><p style='margin:8px 0'>")
    .replace(/\n/g, "<br>")

  return `<p style='margin:8px 0;line-height:1.8'>${html}</p>`
}

/* ── Editor Modal (same as NotesPage) ──────────────────────────────────────── */

function NoteEditor({
  note,
  onSave,
  onClose,
}: {
  note: Note | null
  onSave: (data: { title: string; category: string; content: string; tags: string[]; pinned: boolean }) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(note?.title ?? "")
  const [category, setCategory] = useState<Category>(note?.category ?? "筆記")
  const [content, setContent] = useState(note?.content ?? "")
  const [tagInput, setTagInput] = useState("")
  const [tags, setTags] = useState<string[]>(note?.tags ?? [])
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)

  const CATEGORIES: Category[] = ["筆記", "知識", "貼文", "待辦"]

  const addTag = () => {
    const t = tagInput.trim()
    if (t && !tags.includes(t)) {
      setTags((prev) => [...prev, t])
      setTagInput("")
    }
  }

  const handleSave = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await onSave({ title: title.trim(), category, content: content.trim(), tags, pinned: note?.pinned ?? false })
    } finally {
      setSaving(false)
    }
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
          <h2>{note ? "編輯" : "新增"}</h2>
          <button className="btn btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="card-body">
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
                boxSizing: "border-box",
              }}
            />
          </div>

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
                <option key={c} value={c}>{categoryIcon[c]} {c}</option>
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
                  <span onClick={() => setTags((prev) => prev.filter((x) => x !== t))} style={{ cursor: "pointer", color: "var(--danger)" }}>×</span>
                </span>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              支援 Markdown：# 標題 **粗體** *斜體* `程式碼` - 列表
            </span>
            <button className="btn btn-sm" onClick={() => setPreview(!preview)}>
              {preview ? "編輯" : "預覽"}
            </button>
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: 6, minHeight: 300, overflow: "auto" }}>
            {preview ? (
              <div style={{ padding: 16, fontSize: 14, lineHeight: 1.7 }} dangerouslySetInnerHTML={{ __html: renderContent(content) }} />
            ) : (
              <textarea
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
                  boxSizing: "border-box",
                }}
              />
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!title.trim() || saving}>
              {saving ? "儲存中..." : "儲存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Related Notes Sidebar ─────────────────────────────────────────────────── */

function RelatedNotes({ currentId, category, onNavigate }: { currentId: string; category: Category; onNavigate: (id: string) => void }) {
  const [related, setRelated] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listNotesApi(1, category).then((data) => {
      setRelated(data.items.filter((n) => n.id !== currentId).slice(0, 5))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [currentId, category])

  if (loading) return null

  return (
    <div className="card" style={{ position: "sticky", top: 80 }}>
      <div className="card-header">
        <h3 style={{ fontSize: 14 }}>同分類筆記</h3>
      </div>
      <div className="card-body" style={{ padding: 8 }}>
        {related.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "12px 8px" }}>暫無其他筆記</div>
        ) : (
          related.map((n) => (
            <div
              key={n.id}
              onClick={() => onNavigate(n.id)}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                borderRadius: 6,
                fontSize: 13,
                color: "var(--text-secondary)",
                borderBottom: "1px solid var(--border)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover-bg)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ fontWeight: 500, color: "var(--text)" }}>{n.title}</div>
              <div style={{ fontSize: 11, marginTop: 2 }}>{formatDate(n.updated_at)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */

export function NoteDetailPage() {

  const { noteId } = useParams<{ noteId: string }>()
  const navigate = useNavigate()
  const [note, setNote] = useState<Note | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showEditor, setShowEditor] = useState(false)

  const fetchNote = useCallback(async () => {
    if (!noteId) return
    setLoading(true)
    setError(null)
    try {
      const data = await getNoteApi(noteId)
      setNote(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [noteId])

  useEffect(() => {
    fetchNote()
  }, [fetchNote])

  const handleSave = async (data: { title: string; category: string; content: string; tags: string[]; pinned: boolean }) => {
    if (!note) return
    try {
      await updateNoteApi(note.id, data as Partial<Note>)
      setShowEditor(false)
      fetchNote()
    } catch (e: any) {
      alert("儲存失敗：" + e.message)
    }
  }

  const handleDelete = async () => {
    if (!note) return
    if (confirm("確定刪除此筆記？")) {
      try {
        await deleteNoteApi(note.id)
        navigate("/notes")
      } catch (e: any) {
        alert("刪除失敗：" + e.message)
      }
    }
  }

  const handleTogglePin = async () => {
    if (!note) return
    try {
      await updateNoteApi(note.id, { pinned: !note.pinned })
      fetchNote()
    } catch (e: any) {
      alert("操作失敗：" + e.message)
    }
  }

  const handleNavigateToNote = (id: string) => {
    navigate(`/notes/${id}`)
  }

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      {/* Back button */}
      <button
        className="btn btn-sm"
        onClick={() => navigate("/notes")}
        style={{ marginBottom: 16, display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        ← 返回筆記列表
      </button>

      {/* Loading */}
      {loading && (
        <div className="card">
          <div className="card-body" style={{ textAlign: "center", padding: 60 }}>
            <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>載入中…...</div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div className="card-body" style={{ padding: 20, textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <div style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div>
            <button className="btn" onClick={() => navigate("/notes")}>返回列表</button>
          </div>
        </div>
      )}

      {/* Note detail */}
      {note && !loading && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 20 }}>
          <div>
            {/* Article card */}
            <div className="card">
              <div className="card-body" style={{ padding: 24 }}>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                      style={{
                        padding: "4px 12px",
                        borderRadius: 12,
                        fontSize: 13,
                        fontWeight: 600,
                        background: `${categoryColor[note.category]}18`,
                        color: categoryColor[note.category],
                      }}
                    >
                      {categoryIcon[note.category]} {note.category}
                    </span>
                    {note.pinned && (
                      <span style={{ color: "#f59e0b", fontSize: 16 }} title="置頂">★</span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      className="btn btn-sm"
                      onClick={handleTogglePin}
                      title={note.pinned ? "取消置頂" : "置頂"}
                      style={{ color: note.pinned ? "#f59e0b" : undefined }}
                    >
                      {note.pinned ? "★ 取消置頂" : "☆ 置頂"}
                    </button>
                    <button className="btn btn-sm" onClick={() => setShowEditor(true)} title="編輯">✎ 編輯</button>
                    <button className="btn btn-sm" onClick={handleDelete} title="刪除" style={{ color: "var(--danger)" }}>🗑 刪除</button>
                  </div>
                </div>

                {/* Title */}
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 12px", lineHeight: 1.4 }}>{note.title}</h1>

                {/* Tags */}
                {note.tags.length > 0 && (
                  <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
                    {note.tags.map((t) => (
                      <span key={t} className="tag" style={{ fontSize: 11 }}>#{t}</span>
                    ))}
                  </div>
                )}

                {/* Meta */}
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
                  <span>作者：{note.author}</span>
                  <span style={{ margin: "0 8px" }}>·</span>
                  <span>建立：{formatDate(note.created_at)}</span>
                  <span style={{ margin: "0 8px" }}>·</span>
                  <span>更新：{formatDate(note.updated_at)}</span>
                  <span style={{ margin: "0 8px" }}>·</span>
                  <span>版本：v{note.version}</span>
                </div>

                {/* Content */}
                <div
                  className="note-content"
                  style={{ fontSize: 15, lineHeight: 1.8 }}
                  dangerouslySetInnerHTML={{ __html: renderContent(note.content) }}
                />
              </div>
            </div>

            {/* Navigation between notes */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
              <button className="btn btn-sm" onClick={() => navigate("/notes")}>
                ← 返回列表
              </button>
              <button className="btn btn-sm" onClick={() => setShowEditor(true)}>
                ✎ 編輯此文
              </button>
            </div>
          </div>

          {/* Sidebar */}
          <div>
            <RelatedNotes currentId={note.id} category={note.category} onNavigate={handleNavigateToNote} />
          </div>
        </div>
      )}

      {/* Editor modal */}
      {showEditor && note && (
        <NoteEditor
          note={note}
          onSave={handleSave}
          onClose={() => setShowEditor(false)}
        />
      )}
    </div>
  )
}