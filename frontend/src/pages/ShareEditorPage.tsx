import { useCallback, useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { api } from "../auth"

interface Post {
  id: number
  title: string
  slug: string
  cover_image: string | null
  video_file: string | null
  content: string
  excerpt: string
  status: string
  author: string
  created_at: string
  updated_at: string
  published_at: string | null
}

export function ShareEditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isEdit = !!id

  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [excerpt, setExcerpt] = useState("")
  const [content, setContent] = useState("")
  const [status, setStatus] = useState("draft")
  const [coverImage, setCoverImage] = useState<string | null>(null)
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isEdit) return
    setLoading(true)
    api<Post>(`/api/v1/posts?page=1&page_size=100`)
      .then((data: any) => {
        const post = data.items?.find((p: Post) => String(p.id) === id)
        if (post) {
          setTitle(post.title)
          setSlug(post.slug)
          setExcerpt(post.excerpt)
          setContent(post.content)
          setStatus(post.status)
          setCoverImage(post.cover_image)
        } else {
          setError("文章不存在")
        }
      })
      .catch(() => setError("載入失敗"))
      .finally(() => setLoading(false))
  }, [id, isEdit])

  // Auto-generate slug from title
  const generateSlug = (text: string) => {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim()
  }

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setTitle(v)
    if (!isEdit || !slug) setSlug(generateSlug(v))
  }

  const handleSave = async () => {
    if (!title.trim() || !slug.trim()) {
      setError("標題和Slug不能為空")
      return
    }
    setSaving(true)
    setError("")
    try {
      const body = { title, slug, excerpt, content, status, cover_image: coverImage }
      if (isEdit) {
        await api(`/api/v1/posts/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      } else {
        await api(`/api/v1/posts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      }
      navigate("/admin/share-manage")
    } catch (e: any) {
      setError(e.message || "保存失敗")
    } finally {
      setSaving(false)
    }
  }

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !isEdit || !id) return
    setUploadingCover(true)
    setError("")
    try {
      const formData = new FormData()
      formData.append("file", file)
      const res = await api(`/api/v1/posts/${id}/upload-cover`, {
        method: "POST",
        body: formData,
      } as RequestInit)
      setCoverImage((res as any).filename)
    } catch (e: any) {
      setError(e.message || "上傳失敗")
    } finally {
      setUploadingCover(false)
    }
  }

  if (loading) return <p>載入中…</p>

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>{isEdit ? "編輯文章" : "新建文章"}</h2>
        <Link to="/admin/share-manage" className="btn">← 返回列表</Link>
      </div>

      {error && <div style={{ background: "#fef2f2", color: "#dc2626", padding: "12px 16px", borderRadius: "8px", marginBottom: 16 }}>{error}</div>}

      <div style={{ display: "grid", gap: 20 }}>
        {/* Title & Slug */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>標題</label>
            <input className="form-input" value={title} onChange={handleTitleChange} placeholder="文章標題" />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>Slug</label>
            <input className="form-input" value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^\w-]/g, ""))} placeholder="url-slug" />
          </div>
        </div>

        {/* Excerpt */}
        <div>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>摘要</label>
          <input className="form-input" value={excerpt} onChange={e => setExcerpt(e.target.value)} placeholder="文章摘要（顯示在首頁卡片上）" />
        </div>

        {/* Cover Image */}
        <div>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>封面圖片</label>
          {coverImage && <img src={`/share-static/covers/${coverImage}`} alt="cover" style={{ maxWidth: 400, borderRadius: 8, marginBottom: 8 }} />}
          <input type="file" accept="image/*" onChange={handleCoverUpload} disabled={uploadingCover} />
          {uploadingCover && <span style={{ marginLeft: 8, color: "#888" }}>上傳中…</span>}
        </div>

        {/* Content */}
        <div>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>內容</label>
          <textarea
            className="form-input"
            style={{ minHeight: 300, fontFamily: "monospace", fontSize: 14 }}
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="支援基本 Markdown: **粗體** *斜體* `程式碼`"
          />
        </div>

        {/* Status */}
        <div>
          <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>狀態</label>
          <select className="form-input" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="draft">草稿</option>
            <option value="published">已發布</option>
            <option value="archived">已歸檔</option>
          </select>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button className="btn" onClick={() => navigate("/admin/share-manage")}>取消</button>
        </div>
      </div>
    </div>
  )
}
