import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api, getToken } from "../auth"

interface SharePost {
  id: number
  title: string
  slug: string
  cover_image: string | null
  video_file: string | null
  excerpt: string
  source_type: string | null
  created_at: string
  published_at: string | null
}

function coverUrl(cover: string | null | undefined): string | undefined {
  if (!cover) return undefined
  if (cover.startsWith("http")) return cover
  return `/share-static/covers/${cover}`
}

const TOPICS = [
  { icon: "🤖", label: "AI / LLM" },
  { icon: "☁️", label: "雲端運算" },
  { icon: "🐧", label: "系統管理" },
  { icon: "🎨", label: "創作" },
  { icon: "🔧", label: "DevOps" },
  { icon: "📚", label: "學習筆記" },
]

export function ShareHomePage() {
  const [posts, setPosts] = useState<SharePost[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [authed, setAuthed] = useState(false)
  const [activeTopic, setActiveTopic] = useState<string | null>(null)
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
    setAuthed(!!getToken())
  }, [page, fetchPosts])

  const pages = Math.ceil(total / PAGE_SIZE)

  // Filter posts by topic (client-side, flexible matching)
  const filteredPosts = activeTopic
    ? posts.filter(p => {
        const text = (p.title + " " + p.excerpt).toLowerCase()
        // Try multiple matching strategies
        const topicLower = activeTopic.toLowerCase()
        // Direct match
        if (text.includes(topicLower)) return true
        // Try individual words (e.g. "AI / LLM" → "ai", "llm")
        const words = topicLower.split(/[\s/·]+/).filter(w => w.length > 1)
        return words.some(w => text.includes(w))
      })
    : posts

  return (
    <div className="sh">
      {/* Header */}
      <header className="sh-header">
        <div className="sh-header-inner">
          <Link to="/" className="sh-logo">
            <span className="sh-logo-mark">◈</span>
            <span className="sh-logo-text">OPS<span className="sh-logo-accent">CONTROL</span></span>
          </Link>
          <nav className="sh-nav">
            <a href="#posts">文章</a>
            <a href="#topics">主題</a>
            {authed ? (
              <Link to="/admin/overview" className="sh-nav-cta">控制台</Link>
            ) : (
              <Link to="/login" className="sh-nav-cta">登入</Link>
            )}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="sh-hero">
        <div className="sh-hero-grid" />
        <div className="sh-hero-inner">
          <span className="sh-hero-badge">◆ 技術分享與作品展示</span>
          <h1>
            記錄 <span className="sh-hero-grad">技術探索</span> 與創作
          </h1>
          <p className="sh-hero-sub">
            AI · 雲端運算 · 系統管理 · 創作 — 分享學習過程與實作成果
          </p>
          <div className="sh-hero-actions">
            <a href="#posts" className="sh-btn sh-btn-primary">瀏覽文章</a>
            {authed ? (
              <Link to="/admin/overview" className="sh-btn sh-btn-ghost">進入控制台</Link>
            ) : (
              <Link to="/login" className="sh-btn sh-btn-ghost">登入</Link>
            )}
          </div>
        </div>
      </section>

      {/* Topics */}
      <section className="sh-section" id="topics">
        <div className="sh-container">
          <div className="sh-section-head">
            <h2>主題分類</h2>
            <p>按領域瀏覽技術內容</p>
          </div>
          <div className="sh-topics">
            <button
              className={`sh-topic-chip ${!activeTopic ? "active" : ""}`}
              onClick={() => setActiveTopic(null)}
            >
              <span className="sh-topic-icon">✨</span>
              全部
            </button>
            {TOPICS.map(t => (
              <button
                key={t.label}
                className={`sh-topic-chip ${activeTopic === t.label ? "active" : ""}`}
                onClick={() => setActiveTopic(activeTopic === t.label ? null : t.label)}
              >
                <span className="sh-topic-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Posts */}
      <section className="sh-section sh-section-alt" id="posts">
        <div className="sh-container">
          <div className="sh-section-head">
            <h2>技術分享</h2>
            <p>
              {activeTopic ? `篩選：${activeTopic}` : "AI · 雲端運算 · 系統管理 · 創作"}
            </p>
          </div>
          {loading ? (
            <div className="sh-loading">載入中…</div>
          ) : filteredPosts.length === 0 ? (
            <div className="sh-empty">
              <span className="sh-empty-icon">📝</span>
              <h3>{activeTopic ? `沒有「${activeTopic}」相關文章` : "還沒有已發布的文章"}</h3>
              <p>{activeTopic ? "試試其他主題" : "內容發布後會顯示在這裡"}</p>
            </div>
          ) : (
            <>
              <div className="sh-posts-grid">
                {filteredPosts.map(post => (
                  <Link key={post.id} to={`/p/${post.id}`} className="sh-post-card">
                    {post.cover_image && (
                      <div className="sh-post-cover">
                        <img src={coverUrl(post.cover_image)} alt={post.title} />
                        {post.video_file && <span className="sh-video-badge">▶ 影片</span>}
                      </div>
                    )}
                    <div className="sh-post-body">
                      {post.source_type && (
                        <span className={`sh-source-badge sh-source-${post.source_type}`}>
                          {post.source_type === "note" ? "📝 筆記" : "🎨 AI 創作"}
                        </span>
                      )}
                      <h3>{post.title}</h3>
                      <p>{post.excerpt}</p>
                      <span className="sh-post-date">
                        {post.published_at ? new Date(post.published_at).toLocaleDateString("zh-TW") : ""}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
              {pages > 1 && (
                <div className="sh-pagination">
                  {Array.from({ length: pages }, (_, i) => i + 1).map(p => (
                    <button key={p} className={p === page ? "active" : ""} onClick={() => setPage(p)}>
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
      <footer className="sh-footer">
        <div className="sh-footer-inner">
          <div className="sh-footer-brand">
            <span className="sh-logo-mark">◈</span> OPS Control System
          </div>
          <p>© {new Date().getFullYear()} OPS Control System · 技術分享與作品展示</p>
        </div>
      </footer>

      <style>{shareHomeStyles}</style>
    </div>
  )
}

const shareHomeStyles = `
.sh {
  min-height: 100vh;
  background: #0a0e1a;
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
  --sh-bg: #0a0e1a;
  --sh-surface: #111827;
  --sh-surface2: #1a2332;
  --sh-border: #1e293b;
  --sh-text: #e2e8f0;
  --sh-dim: #64748b;
  --sh-accent: #38bdf8;
  --sh-accent2: #818cf8;
}

/* ── Header ── */
.sh-header {
  position: sticky; top: 0; z-index: 100;
  background: rgba(10,14,26,0.82);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--sh-border);
}
.sh-header-inner {
  max-width: 1200px; margin: 0 auto; padding: 14px 24px;
  display: flex; align-items: center; justify-content: space-between;
}
.sh-logo {
  display: flex; align-items: center; gap: 10px;
  font-size: 19px; font-weight: 800; color: #f1f5f9; text-decoration: none; letter-spacing: -.02em;
}
.sh-logo-mark { color: var(--sh-accent); font-size: 22px; }
.sh-logo-accent { color: var(--sh-accent); }
.sh-nav { display: flex; gap: 22px; align-items: center; }
.sh-nav a { color: var(--sh-dim); text-decoration: none; font-size: 14px; transition: color .2s; }
.sh-nav a:hover { color: var(--sh-text); }
.sh-nav-cta {
  padding: 7px 16px; border-radius: 8px; font-size: 13px; font-weight: 600;
  background: var(--sh-accent); color: #0a0e1a !important;
  transition: opacity .2s;
}
.sh-nav-cta:hover { opacity: .88; }

/* ── Hero ── */
.sh-hero {
  position: relative; overflow: hidden;
  padding: 100px 24px 80px;
  background:
    radial-gradient(ellipse 80% 60% at 50% -10%, rgba(56,189,248,.14), transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 20%, rgba(129,140,248,.10), transparent 50%),
    linear-gradient(180deg, #0a0e1a 0%, #0d1220 100%);
}
.sh-hero-grid {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(rgba(148,163,184,.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148,163,184,.05) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 30%, #000, transparent 80%);
}
.sh-hero-inner { position: relative; z-index: 1; max-width: 760px; margin: 0 auto; text-align: center; }
.sh-hero-badge {
  display: inline-block; padding: 5px 14px; border-radius: 20px;
  font-size: 12px; font-weight: 600; letter-spacing: .04em;
  color: var(--sh-accent); background: rgba(56,189,248,.10);
  border: 1px solid rgba(56,189,248,.22); margin-bottom: 22px;
}
.sh-hero h1 {
  font-size: 50px; font-weight: 800; line-height: 1.15; letter-spacing: -.03em;
  color: #f8fafc; margin: 0 0 18px;
}
.sh-hero-grad {
  background: linear-gradient(135deg, var(--sh-accent), var(--sh-accent2));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.sh-hero-sub { font-size: 17px; color: var(--sh-dim); margin: 0 0 36px; line-height: 1.7; }
.sh-hero-actions { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
.sh-btn {
  padding: 12px 26px; border-radius: 10px; font-size: 15px; font-weight: 600;
  text-decoration: none; transition: all .2s; display: inline-block;
}
.sh-btn-primary { background: var(--sh-accent); color: #0a0e1a; }
.sh-btn-primary:hover { background: #7dd3fc; transform: translateY(-1px); box-shadow: 0 8px 24px rgba(56,189,248,.25); }
.sh-btn-ghost { border: 1px solid var(--sh-border); color: var(--sh-text); background: transparent; }
.sh-btn-ghost:hover { border-color: var(--sh-dim); background: rgba(255,255,255,.04); }

/* ── Sections ── */
.sh-section { padding: 64px 24px; }
.sh-section-alt { background: #0d1220; border-top: 1px solid var(--sh-border); border-bottom: 1px solid var(--sh-border); }
.sh-container { max-width: 1200px; margin: 0 auto; }
.sh-section-head { text-align: center; margin-bottom: 40px; }
.sh-section-head h2 { font-size: 30px; font-weight: 800; color: #f1f5f9; margin: 0 0 8px; letter-spacing: -.02em; }
.sh-section-head p { font-size: 15px; color: var(--sh-dim); margin: 0; }

/* ── Topics ── */
.sh-topics { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.sh-topic-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 20px; border-radius: 24px;
  font-size: 14px; font-weight: 600; color: var(--sh-text);
  background: var(--sh-surface); border: 1px solid var(--sh-border);
  transition: all .2s; cursor: pointer;
  font-family: inherit;
}
.sh-topic-chip:hover { border-color: rgba(56,189,248,.35); background: var(--sh-surface2); transform: translateY(-2px); }
.sh-topic-chip.active {
  background: rgba(56,189,248,.12); border-color: var(--sh-accent);
  color: var(--sh-accent); box-shadow: 0 0 12px rgba(56,189,248,.15);
}
.sh-topic-icon { font-size: 18px; }

/* ── Posts ── */
.sh-posts-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px;
}
.sh-post-card {
  background: var(--sh-surface); border-radius: 12px; overflow: hidden;
  text-decoration: none; color: inherit; border: 1px solid var(--sh-border);
  transition: all .2s; display: block;
}
.sh-post-card:hover { transform: translateY(-3px); border-color: rgba(56,189,248,.3); box-shadow: 0 10px 28px rgba(0,0,0,.3); }
.sh-post-cover { height: 190px; overflow: hidden; position: relative; }
.sh-post-cover img { width: 100%; height: 100%; object-fit: cover; }
.sh-video-badge {
  position: absolute; bottom: 10px; right: 10px;
  padding: 3px 10px; border-radius: 6px;
  font-size: 12px; font-weight: 600;
  background: rgba(0,0,0,.7); color: #fff;
  backdrop-filter: blur(4px);
}
.sh-post-body { padding: 20px; }
.sh-source-badge {
  display: inline-block; padding: 3px 10px; border-radius: 10px;
  font-size: 11px; font-weight: 600; margin-bottom: 10px;
}
.sh-source-note { background: rgba(59,130,246,.12); color: #60a5fa; }
.sh-source-comfyui { background: rgba(168,85,247,.12); color: #c084fc; }
.sh-post-body h3 { margin: 0 0 8px; font-size: 17px; font-weight: 600; color: #f1f5f9; line-height: 1.4; }
.sh-post-body p { margin: 0 0 12px; color: var(--sh-dim); font-size: 14px; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sh-post-date { font-size: 12px; color: var(--sh-dim); }
.sh-loading { text-align: center; padding: 48px; color: var(--sh-dim); font-size: 15px; }
.sh-pagination { display: flex; justify-content: center; gap: 8px; margin-top: 36px; }
.sh-pagination button {
  padding: 8px 14px; border: 1px solid var(--sh-border); background: var(--sh-surface);
  border-radius: 6px; cursor: pointer; font-size: 14px; color: var(--sh-text); transition: all .2s;
}
.sh-pagination button.active, .sh-pagination button:hover { background: var(--sh-accent); color: #0a0e1a; border-color: var(--sh-accent); }

/* ── Empty state ── */
.sh-empty { text-align: center; padding: 64px 24px; }
.sh-empty-icon { font-size: 48px; display: block; margin-bottom: 16px; }
.sh-empty h3 { font-size: 18px; font-weight: 700; color: #f1f5f9; margin: 0 0 8px; }
.sh-empty p { font-size: 14px; color: var(--sh-dim); margin: 0; }

/* ── Footer ── */
.sh-footer { border-top: 1px solid var(--sh-border); padding: 32px 24px; }
.sh-footer-inner { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.sh-footer-brand { font-size: 15px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 8px; }
.sh-footer p { margin: 0; font-size: 13px; color: var(--sh-dim); }

@media (max-width: 768px) {
  .sh-hero { padding: 64px 16px 48px; }
  .sh-hero h1 { font-size: 34px; }
  .sh-hero-sub { font-size: 15px; }
  .sh-topics { gap: 8px; }
  .sh-topic-chip { padding: 8px 14px; font-size: 13px; }
  .sh-posts-grid { grid-template-columns: 1fr; }
  .sh-header-inner { padding: 12px 16px; }
  .sh-nav { gap: 14px; }
}
`
