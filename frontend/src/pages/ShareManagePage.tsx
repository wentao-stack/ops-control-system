import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../auth"

interface Post {
  id: number
  title: string
  slug: string
  cover_image: string | null
  excerpt: string
  status: string
  author: string
  created_at: string
  updated_at: string
  published_at: string | null
}

export function ShareManagePage() {
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 20

  const fetchPosts = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
      if (statusFilter) params.set("status_filter", statusFilter)
      const data = await api<{ items: Post[]; total: number }>(`/api/v1/posts?${params}`)
      setPosts(data.items)
      setTotal(data.total)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  useEffect(() => { fetchPosts() }, [fetchPosts])

  const handleStatusChange = async (id: number, status: string) => {
    try {
      await api(`/api/v1/posts/${id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) })
      fetchPosts()
    } catch (e) {
      console.error(e)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm("確定刪除此文章？")) return
    try {
      await api(`/api/v1/posts/${id}`, { method: "DELETE" })
      fetchPosts()
    } catch (e) {
      console.error(e)
    }
  }

  const statusBadge = (s: string) => {
    const map: Record<string, { label: string; color: string }> = {
      draft: { label: "草稿", color: "#888" },
      published: { label: "已發布", color: "#22c55e" },
      archived: { label: "已歸檔", color: "#f59e0b" },
    }
    const c = map[s] || { label: s, color: "#888" }
    return <span style={{ background: c.color + "22", color: c.color, padding: "2px 8px", borderRadius: "4px", fontSize: "12px" }}>{c.label}</span>
  }

  const pages = Math.ceil(total / PAGE_SIZE)

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>內容管理</h2>
        <Link to="/admin/share-manage/new" className="btn">
          + 新建文章
        </Link>
      </div>

      <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
        {["", "draft", "published", "archived"].map(s => (
          <button
            key={s}
            className={`btn btn-sm ${statusFilter === s ? "btn-primary" : ""}`}
            onClick={() => { setStatusFilter(s); setPage(1) }}
          >
            {s === "" ? "全部" : s === "draft" ? "草稿" : s === "published" ? "已發布" : "已歸檔"}
          </button>
        ))}
      </div>

      {loading ? <p>載入中…</p> : (
        <table className="data-table">
          <thead>
            <tr>
              <th>標題</th>
              <th>Slug</th>
              <th>狀態</th>
              <th>作者</th>
              <th>發布時間</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {posts.map(post => (
              <tr key={post.id}>
                <td>{post.title}</td>
                <td><code>{post.slug}</code></td>
                <td>{statusBadge(post.status)}</td>
                <td>{post.author}</td>
                <td>{post.published_at ? new Date(post.published_at).toLocaleDateString("zh-TW") : "—"}</td>
                <td>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Link to={`/admin/share-manage/${post.id}`} className="btn btn-sm">編輯</Link>
                    {post.status !== "published" ? (
                      <button className="btn btn-sm" onClick={() => handleStatusChange(post.id, "published")}>發布</button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => handleStatusChange(post.id, "draft")}>下架</button>
                    )}
                    <button className="btn btn-sm" style={{ color: "#ef4444" }} onClick={() => handleDelete(post.id)}>刪除</button>
                  </div>
                </td>
              </tr>
            ))}
            {posts.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: "center", padding: 40, color: "#888" }}>暫無文章</td></tr>
            )}
          </tbody>
        </table>
      )}

      {pages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 24 }}>
          {Array.from({ length: pages }, (_, i) => i + 1).map(p => (
            <button key={p} className={`btn btn-sm ${page === p ? "btn-primary" : ""}`} onClick={() => setPage(p)}>{p}</button>
          ))}
        </div>
      )}
    </div>
  )
}
