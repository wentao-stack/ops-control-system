import { useCallback, useEffect, useState } from "react"
import { useParams, Link } from "react-router-dom"
import { api } from "../auth"

interface SharePost {
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

export function SharePostPage() {
  const { slug } = useParams<{ slug: string }>()
  const [post, setPost] = useState<SharePost | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!slug) return
    setLoading(true)
    setError("")
    api<SharePost>(`/api/v1/share/posts/${slug}`)
      .then(setPost)
      .catch(() => setError("文章不存在或已下架"))
      .finally(() => setLoading(false))
  }, [slug])

  if (loading) return <div className="share-post-loading">載入中…</div>
  if (error) return (
    <div className="share-post-error">
      <h2>{error}</h2>
      <Link to="/">← 回到首頁</Link>
    </div>
  )
  if (!post) return null

  return (
    <div className="share-post-page">
      <header className="share-header">
        <div className="share-header-inner">
          <Link to="/" className="share-logo">
            <span className="brand-mark">◈</span>
            <span className="share-logo-text">OPS Control</span>
          </Link>
          <nav className="share-nav">
            <a href="/">首頁</a>
            <a href="/admin/overview">控制台</a>
          </nav>
        </div>
      </header>

      <article className="share-article">
        {post.cover_image && (
          <div className="share-article-cover">
            <img src={`/share-static/covers/${post.cover_image}`} alt={post.title} />
          </div>
        )}

        <div className="share-article-content">
          <h1>{post.title}</h1>
          <div className="share-article-meta">
            <span>{post.author}</span>
            <span>·</span>
            <span>{post.published_at ? new Date(post.published_at).toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric" }) : ""}</span>
          </div>

          {post.video_file && (
            <div className="share-article-video">
              <video controls poster={post.cover_image ? `/share-static/covers/${post.cover_image}` : undefined}>
                <source src={`/share-static/videos/${post.video_file}`} type="video/mp4" />
                您的瀏覽器不支援影片播放
              </video>
            </div>
          )}

          <div className="share-article-body" dangerouslySetInnerHTML={{ __html: renderContent(post.content) }} />
        </div>
      </article>

      <div className="share-article-nav">
        <Link to="/">← 回到首頁</Link>
      </div>

      <footer className="share-footer">
        <p>© {new Date().getFullYear()} OPS Control System</p>
      </footer>

      <style>{sharePostStyles}</style>
    </div>
  )
}

function renderContent(content: string): string {
  // Simple markdown-like rendering: convert newlines to <br> and basic formatting
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>")
}

const sharePostStyles = `
.share-post-page {
  min-height: 100vh;
  background: #fafafa;
  color: #1a1a1a;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.share-post-loading, .share-post-error {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #666;
}

.share-post-error a {
  color: #6366f1;
  text-decoration: none;
}

.share-article {
  max-width: 800px;
  margin: 0 auto;
}

.share-article-cover {
  width: 100%;
  max-height: 480px;
  overflow: hidden;
}

.share-article-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.share-article-content {
  background: white;
  padding: 48px;
  margin-top: 1px;
}

.share-article-content h1 {
  font-size: 36px;
  font-weight: 800;
  margin: 0 0 16px;
  line-height: 1.3;
  letter-spacing: -0.5px;
}

.share-article-meta {
  display: flex;
  gap: 8px;
  color: #888;
  font-size: 14px;
  margin-bottom: 32px;
}

.share-article-video {
  margin: 32px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #000;
}

.share-article-video video {
  width: 100%;
  display: block;
  max-height: 500px;
}

.share-article-body {
  font-size: 16px;
  line-height: 1.8;
  color: #333;
}

.share-article-body code {
  background: #f3f4f6;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 14px;
}

.share-article-nav {
  max-width: 800px;
  margin: 24px auto;
  padding: 0 24px;
}

.share-article-nav a {
  color: #6366f1;
  text-decoration: none;
  font-size: 14px;
}

.share-article-nav a:hover {
  text-decoration: underline;
}

@media (max-width: 768px) {
  .share-article-content { padding: 24px; }
  .share-article-content h1 { font-size: 24px; }
}
`
