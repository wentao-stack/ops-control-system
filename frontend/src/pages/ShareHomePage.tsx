import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api, getToken } from "../auth"
import type { Summary, Asset } from "../types"

interface SharePost {
  id: number
  title: string
  slug: string
  cover_image: string | null
  excerpt: string
  created_at: string
  published_at: string | null
}

const FEATURES = [
  { icon: "🖥", title: "資產庫存", desc: "統一管理伺服器、容器與雲端資源，環境與健康狀態一目了然。", to: "/admin/assets" },
  { icon: "📡", title: "主機監控", desc: "CPU、記憶體、磁碟與 GPU 即時指標，遠端主機一覽無遺。", to: "/admin/monitoring" },
  { icon: "🔧", title: "服務偵測", desc: "systemd 與 Docker 服務狀態偵測，Supervisor 程序管理。", to: "/admin/services" },
  { icon: "⌨", title: "SSH 終端", desc: "瀏覽器內 SSH 終端與遠端命令執行，免裝客戶端。", to: "/admin/remote" },
  { icon: "🤖", title: "AI Agent", desc: "對話式運維助手，工具調用、Runbook 執行與 RAG 知識檢索。", to: "/admin/agent" },
  { icon: "🔄", title: "工作流", desc: "LLM、API、Shell 步驟組合，自動化運維流程。", to: "/admin/workflow" },
  { icon: "📝", title: "筆記知識庫", desc: "運維筆記與知識沉澱，支援搜索與分類。", to: "/admin/notes" },
  { icon: "🎨", title: "ComfyUI", desc: "AI 圖像與影片生成工作流，本地 GPU 推理。", to: "/admin/comfyui" },
]

export function ShareHomePage() {
  const [posts, setPosts] = useState<SharePost[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [authed, setAuthed] = useState(false)
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
    api<Summary>("/api/v1/inventory/summary").then(setSummary).catch(() => {})
    api<{ items: Asset[]; total: number }>("/api/v1/assets").then(d => setAssets(d.items ?? [])).catch(() => {})
  }, [page, fetchPosts])

  const pages = Math.ceil(total / PAGE_SIZE)
  const healthy = summary?.by_health.healthy ?? 0
  const attention = (summary?.by_health.warning ?? 0) + (summary?.by_health.critical ?? 0)

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
            <a href="#features">功能</a>
            <a href="#system">系統</a>
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
          <span className="sh-hero-badge">◆ 遠端伺服器作業控制平台</span>
          <h1>
            一站式 <span className="sh-hero-grad">運維控制</span> 中心
          </h1>
          <p className="sh-hero-sub">
            資產管理 · 主機監控 · 服務偵測 · SSH 終端 · AI Agent · 工作流自動化
          </p>
          <div className="sh-hero-actions">
            {authed ? (
              <Link to="/admin/overview" className="sh-btn sh-btn-primary">進入控制台 →</Link>
            ) : (
              <Link to="/login" className="sh-btn sh-btn-primary">登入控制台 →</Link>
            )}
            <a href="#features" className="sh-btn sh-btn-ghost">探索功能</a>
          </div>

          {/* Live stats */}
          {summary && (
            <div className="sh-stats">
              <div className="sh-stat">
                <span className="sh-stat-num">{summary.total}</span>
                <span className="sh-stat-label">資產總數</span>
              </div>
              <div className="sh-stat">
                <span className="sh-stat-num sh-stat-ok">{healthy}</span>
                <span className="sh-stat-label">健康</span>
              </div>
              <div className="sh-stat">
                <span className="sh-stat-num" style={{ color: attention > 0 ? "var(--sh-warn)" : "var(--sh-dim)" }}>
                  {attention}
                </span>
                <span className="sh-stat-label">需關注</span>
              </div>
              <div className="sh-stat">
                <span className="sh-stat-num">{assets.length}</span>
                <span className="sh-stat-label">已連線主機</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Features */}
      <section className="sh-section" id="features">
        <div className="sh-container">
          <div className="sh-section-head">
            <h2>核心功能</h2>
            <p>從資產到 AI，覆蓋運維全生命週期</p>
          </div>
          <div className="sh-features-grid">
            {FEATURES.map(f => (
              <Link key={f.to} to={f.to} className="sh-feature-card">
                <span className="sh-feature-icon">{f.icon}</span>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
                <span className="sh-feature-link">進入 →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* System status */}
      {summary && assets.length > 0 && (
        <section className="sh-section sh-section-alt" id="system">
          <div className="sh-container">
            <div className="sh-section-head">
              <h2>系統狀態</h2>
              <p>即時資產健康概覽</p>
            </div>
            <div className="sh-system-grid">
              {assets.map(a => (
                <Link key={a.id} to={`/admin/assets/${a.id}`} className="sh-system-card">
                  <div className="sh-system-top">
                    <span className={`sh-dot sh-dot-${a.health_status}`} />
                    <strong>{a.name}</strong>
                    <span className="sh-system-env">{a.environment}</span>
                  </div>
                  <div className="sh-system-bottom">
                    <span>{a.asset_type}</span>
                    <span className="sh-system-health">{healthLabel(a.health_status)}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Posts */}
      {total > 0 && (
        <section className="sh-section">
          <div className="sh-container">
            <div className="sh-section-head">
              <h2>技術分享</h2>
              <p>AI · 雲端運算 · 系統管理 · 創作</p>
            </div>
            {loading ? (
              <div className="sh-loading">載入中…</div>
            ) : (
              <>
                <div className="sh-posts-grid">
                  {posts.map(post => (
                    <Link key={post.id} to={`/${post.slug}`} className="sh-post-card">
                      {post.cover_image && (
                        <div className="sh-post-cover">
                          <img src={`/share-static/covers/${post.cover_image}`} alt={post.title} />
                        </div>
                      )}
                      <div className="sh-post-body">
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
      )}

      {/* Footer */}
      <footer className="sh-footer">
        <div className="sh-footer-inner">
          <div className="sh-footer-brand">
            <span className="sh-logo-mark">◈</span> OPS Control System
          </div>
          <p>© {new Date().getFullYear()} OPS Control System · 遠端伺服器作業控制平台</p>
        </div>
      </footer>

      <style>{shareHomeStyles}</style>
    </div>
  )
}

function healthLabel(h: string): string {
  const map: Record<string, string> = { healthy: "正常", warning: "警告", critical: "嚴重", unknown: "未知" }
  return map[h] ?? h
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
  --sh-ok: #34d399;
  --sh-warn: #fbbf24;
  --sh-danger: #f87171;
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
  padding: 96px 24px 72px;
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
.sh-hero-inner { position: relative; z-index: 1; max-width: 820px; margin: 0 auto; text-align: center; }
.sh-hero-badge {
  display: inline-block; padding: 5px 14px; border-radius: 20px;
  font-size: 12px; font-weight: 600; letter-spacing: .04em;
  color: var(--sh-accent); background: rgba(56,189,248,.10);
  border: 1px solid rgba(56,189,248,.22); margin-bottom: 22px;
}
.sh-hero h1 {
  font-size: 52px; font-weight: 800; line-height: 1.15; letter-spacing: -.03em;
  color: #f8fafc; margin: 0 0 18px;
}
.sh-hero-grad {
  background: linear-gradient(135deg, var(--sh-accent), var(--sh-accent2));
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.sh-hero-sub { font-size: 17px; color: var(--sh-dim); margin: 0 0 32px; line-height: 1.7; }
.sh-hero-actions { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-bottom: 48px; }
.sh-btn {
  padding: 12px 26px; border-radius: 10px; font-size: 15px; font-weight: 600;
  text-decoration: none; transition: all .2s; display: inline-block;
}
.sh-btn-primary { background: var(--sh-accent); color: #0a0e1a; }
.sh-btn-primary:hover { background: #7dd3fc; transform: translateY(-1px); box-shadow: 0 8px 24px rgba(56,189,248,.25); }
.sh-btn-ghost { border: 1px solid var(--sh-border); color: var(--sh-text); background: transparent; }
.sh-btn-ghost:hover { border-color: var(--sh-dim); background: rgba(255,255,255,.04); }

/* ── Stats ── */
.sh-stats {
  display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;
}
.sh-stat {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 18px 28px; border-radius: 12px;
  background: rgba(17,24,39,.6); border: 1px solid var(--sh-border);
  backdrop-filter: blur(8px); min-width: 110px;
}
.sh-stat-num { font-size: 32px; font-weight: 800; color: #f1f5f9; letter-spacing: -.02em; }
.sh-stat-ok { color: var(--sh-ok); }
.sh-stat-label { font-size: 12px; color: var(--sh-dim); font-weight: 500; }

/* ── Sections ── */
.sh-section { padding: 64px 24px; }
.sh-section-alt { background: #0d1220; border-top: 1px solid var(--sh-border); border-bottom: 1px solid var(--sh-border); }
.sh-container { max-width: 1200px; margin: 0 auto; }
.sh-section-head { text-align: center; margin-bottom: 40px; }
.sh-section-head h2 { font-size: 30px; font-weight: 800; color: #f1f5f9; margin: 0 0 8px; letter-spacing: -.02em; }
.sh-section-head p { font-size: 15px; color: var(--sh-dim); margin: 0; }

/* ── Features ── */
.sh-features-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px;
}
.sh-feature-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 24px; border-radius: 14px; text-decoration: none; color: inherit;
  background: var(--sh-surface); border: 1px solid var(--sh-border);
  transition: all .22s;
}
.sh-feature-card:hover {
  transform: translateY(-3px); border-color: rgba(56,189,248,.35);
  box-shadow: 0 12px 32px rgba(0,0,0,.3);
  background: var(--sh-surface2);
}
.sh-feature-icon { font-size: 28px; }
.sh-feature-card h3 { font-size: 16px; font-weight: 700; color: #f1f5f9; margin: 0; }
.sh-feature-card p { font-size: 13px; color: var(--sh-dim); line-height: 1.6; margin: 0; flex: 1; }
.sh-feature-link { font-size: 13px; font-weight: 600; color: var(--sh-accent); opacity: 0; transition: opacity .2s; }
.sh-feature-card:hover .sh-feature-link { opacity: 1; }

/* ── System status ── */
.sh-system-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px;
}
.sh-system-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 18px 20px; border-radius: 12px; text-decoration: none; color: inherit;
  background: var(--sh-surface); border: 1px solid var(--sh-border);
  transition: all .2s;
}
.sh-system-card:hover { border-color: rgba(56,189,248,.3); background: var(--sh-surface2); }
.sh-system-top { display: flex; align-items: center; gap: 8px; }
.sh-system-top strong { font-size: 14px; color: #f1f5f9; flex: 1; }
.sh-system-env {
  font-size: 11px; padding: 2px 8px; border-radius: 6px;
  background: rgba(129,140,248,.12); color: var(--sh-accent2); font-weight: 600;
}
.sh-system-bottom { display: flex; justify-content: space-between; font-size: 12px; color: var(--sh-dim); }
.sh-system-health { font-weight: 600; }
.sh-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.sh-dot-healthy { background: var(--sh-ok); box-shadow: 0 0 8px rgba(52,211,153,.5); }
.sh-dot-warning { background: var(--sh-warn); box-shadow: 0 0 8px rgba(251,191,36,.5); }
.sh-dot-critical { background: var(--sh-danger); box-shadow: 0 0 8px rgba(248,113,113,.5); }
.sh-dot-unknown { background: var(--sh-dim); }

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
.sh-post-cover { height: 190px; overflow: hidden; }
.sh-post-cover img { width: 100%; height: 100%; object-fit: cover; }
.sh-post-body { padding: 20px; }
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

/* ── Footer ── */
.sh-footer { border-top: 1px solid var(--sh-border); padding: 32px 24px; }
.sh-footer-inner { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.sh-footer-brand { font-size: 15px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 8px; }
.sh-footer p { margin: 0; font-size: 13px; color: var(--sh-dim); }

@media (max-width: 768px) {
  .sh-hero { padding: 64px 16px 48px; }
  .sh-hero h1 { font-size: 34px; }
  .sh-hero-sub { font-size: 15px; }
  .sh-stats { gap: 8px; }
  .sh-stat { padding: 14px 18px; min-width: 80px; }
  .sh-stat-num { font-size: 24px; }
  .sh-features-grid { grid-template-columns: 1fr; }
  .sh-system-grid { grid-template-columns: 1fr; }
  .sh-posts-grid { grid-template-columns: 1fr; }
  .sh-header-inner { padding: 12px 16px; }
  .sh-nav { gap: 14px; }
}
`
