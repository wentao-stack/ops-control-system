import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../auth"

interface SharePost {
  id: number
  title: string
  slug: string
  cover_image: string | null
  excerpt: string
  created_at: string
  published_at: string | null
}

export function ShareHomePage() {
  const [posts, setPosts] = useState<SharePost[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const PAGE_SIZE = 12

  const fetchPosts = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const data = await api<{ items: SharePost[]; total: number }>(`/api/v1/share/posts?page=${p}&page_size=${PAGE_SIZE}`)
      setPosts(data.items)
      setTotal(data.total)
    } catch {
      setPosts([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPosts(page)
  }, [page, fetchPosts])

  const pages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="share-home">
      {/* Header */}
      <header className="share-header">
        <div className="share-header-inner">
          <div className="share-logo">
            <span className="brand-mark">◈</span>
            <span className="share-logo-text">OPS Control</span>
          </div>
          <nav className="share-nav">
            <a href="/">首頁</a>
            <a href="/admin/overview">控制台</a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="share-hero">
        <h1>技術分享與作品展示</h1>
        <p>AI · 雲端運算 · 系統管理 · 創作</p>
      </section>

      {/* Posts Grid */}
      <section className="share-posts-section">
        <div className="share-container">
          {loading ? (
            <div className="share-loading">載入中…</div>
          ) : posts.length === 0 ? (
            <div className="share-empty">暫無已發布內容</div>
          ) : (
            <>
              <div className="share-posts-grid">
                {posts.map(post => (
                  <Link key={post.id} to={`/${post.slug}`} className="share-post-card">
                    {post.cover_image && (
                      <div className="share-post-cover">
                        <img src={`/share-static/covers/${post.cover_image}`} alt={post.title} />
                      </div>
                    )}
                    <div className="share-post-body">
                      <h3>{post.title}</h3>
                      <p>{post.excerpt}</p>
                      <span className="share-post-date">
                        {post.published_at ? new Date(post.published_at).toLocaleDateString("zh-TW") : ""}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>

              {/* Pagination */}
              {pages > 1 && (
                <div className="share-pagination">
                  {Array.from({ length: pages }, (_, i) => i + 1).map(p => (
                    <button
                      key={p}
                      className={p === page ? "active" : ""}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="share-footer">
        <p>© {new Date().getFullYear()} OPS Control System</p>
      </footer>

      <style>{shareHomeStyles}</style>
    </div>
  )
}

const shareHomeStyles = `
.share-home {
  min-height: 100vh;
  background: #fafafa;
  color: #1a1a1a;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.share-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(255,255,255,0.95);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid #eee;
}

.share-header-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.share-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 20px;
  font-weight: 700;
  color: #1a1a1a;
  text-decoration: none;
}

.share-logo .brand-mark {
  color: #6366f1;
  font-size: 24px;
}

.share-nav {
  display: flex;
  gap: 24px;
}

.share-nav a {
  color: #555;
  text-decoration: none;
  font-size: 14px;
  transition: color 0.2s;
}

.share-nav a:hover {
  color: #6366f1;
}

.share-hero {
  text-align: center;
  padding: 80px 24px 60px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.share-hero h1 {
  font-size: 42px;
  font-weight: 800;
  margin: 0 0 16px;
  letter-spacing: -1px;
}

.share-hero p {
  font-size: 18px;
  opacity: 0.9;
  margin: 0;
}

.share-posts-section {
  padding: 48px 24px 80px;
}

.share-container {
  max-width: 1200px;
  margin: 0 auto;
}

.share-posts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 24px;
}

.share-post-card {
  background: white;
  border-radius: 12px;
  overflow: hidden;
  text-decoration: none;
  color: inherit;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  transition: transform 0.2s, box-shadow 0.2s;
  display: block;
}

.share-post-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
}

.share-post-cover {
  height: 200px;
  overflow: hidden;
}

.share-post-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.share-post-body {
  padding: 20px;
}

.share-post-body h3 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
}

.share-post-body p {
  margin: 0 0 12px;
  color: #666;
  font-size: 14px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.share-post-date {
  font-size: 12px;
  color: #999;
}

.share-loading, .share-empty {
  text-align: center;
  padding: 60px 24px;
  color: #999;
  font-size: 16px;
}

.share-pagination {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 40px;
}

.share-pagination button {
  padding: 8px 14px;
  border: 1px solid #ddd;
  background: white;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.share-pagination button.active,
.share-pagination button:hover {
  background: #6366f1;
  color: white;
  border-color: #6366f1;
}

.share-footer {
  text-align: center;
  padding: 32px 24px;
  color: #999;
  font-size: 13px;
  border-top: 1px solid #eee;
}

@media (max-width: 768px) {
  .share-hero h1 { font-size: 28px; }
  .share-hero { padding: 48px 16px 36px; }
  .share-posts-grid { grid-template-columns: 1fr; }
  .share-header-inner { padding: 12px 16px; }
}
`
