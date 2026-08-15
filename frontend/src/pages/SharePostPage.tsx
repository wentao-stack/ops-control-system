import { useCallback, useEffect, useRef, useState } from "react"
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
  source_type: string | null
  source_id: string | null
}

/* ── Media URL Helpers ─────────────────────────────────────────────────────── */

function coverUrl(cover: string | null | undefined): string | undefined {
  if (!cover) return undefined
  if (cover.startsWith("http")) return cover
  return `/share-static/covers/${cover}`
}

function videoUrl(videoFile: string | null | undefined): string | undefined {
  if (!videoFile) return undefined
  if (videoFile.startsWith("http")) return videoFile
  return `/share-static/videos/${videoFile}`
}

/* ── Markdown Renderer ─────────────────────────────────────────────────────── */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n")
  const html: string[] = []
  let i = 0
  let inCode = false
  let codeLang = ""
  let codeLines: string[] = []
  let inTable = false
  let tableRows: string[][] = []
  let inList = false
  let listItems: string[] = []
  let listOrdered = false

  const flushCode = () => {
    if (codeLines.length > 0) {
      const escaped = escapeHtml(codeLines.join("\n"))
      html.push(`<pre class="md-code${codeLang ? ` lang-${codeLang}` : ""}"><div class="md-code-header"><span>${codeLang || "code"}</span><button class="md-copy-btn" onclick="navigator.clipboard.writeText(this.closest('.md-code').querySelector('code').textContent);this.textContent='✓ Copied';setTimeout(()=>this.textContent='Copy',2000)">Copy</button></div><code>${escaped}</code></pre>`)
      codeLines = []
      codeLang = ""
    }
  }

  const flushTable = () => {
    if (tableRows.length > 0) {
      const header = tableRows[0]
      const body = tableRows.slice(1)
      html.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${header.map(c => `<th>${renderInline(c)}</th>`).join("")}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`)
      tableRows = []
    }
  }

  const flushList = () => {
    if (listItems.length > 0) {
      const tag = listOrdered ? "ol" : "ul"
      html.push(`<${tag} class="md-list">${listItems.map(item => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`)
      listItems = []
    }
  }

  const renderInline = (text: string): string => {
    let s = escapeHtml(text)
    // Code spans
    s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // Italic
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return s
  }

  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.trimStart().startsWith("```")) {
      if (!inCode) {
        flushTable()
        flushList()
        inCode = true
        codeLang = line.trim().slice(3).trim()
        codeLines = []
      } else {
        flushCode()
        inCode = false
      }
      i++
      continue
    }

    if (inCode) {
      codeLines.push(line)
      i++
      continue
    }

    // Table
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      flushList()
      const cells = line.split("|").filter(c => c.trim() !== "")
      // Skip separator row
      if (cells.every(c => /^[\s\-:]+$/.test(c.trim()))) {
        i++
        continue
      }
      if (!inTable) {
        inTable = true
        tableRows = []
      }
      tableRows.push(cells.map(c => c.trim()))
      i++
      continue
    } else if (inTable) {
      flushTable()
      inTable = false
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      flushList()
      const level = headingMatch[1].length
      const text = renderInline(headingMatch[2])
      html.push(`<h${level} class="md-h${level}">${text}</h${level}>`)
      i++
      continue
    }

    // Blockquote
    if (line.trimStart().startsWith(">")) {
      flushList()
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""))
        i++
      }
      html.push(`<blockquote class="md-blockquote">${quoteLines.map(l => renderInline(l)).join("<br>")}</blockquote>`)
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushList()
      html.push('<hr class="md-hr">')
      i++
      continue
    }

    // Unordered list
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ulMatch) {
      if (!inList) {
        inList = true
        listOrdered = false
        listItems = []
      }
      listItems.push(ulMatch[1])
      i++
      continue
    }

    // Ordered list
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/)
    if (olMatch) {
      if (!inList) {
        inList = true
        listOrdered = true
        listItems = []
      }
      listItems.push(olMatch[1])
      i++
      continue
    }

    // Flush list if we hit a non-list line
    if (inList) {
      flushList()
      inList = false
    }

    // Empty line
    if (line.trim() === "") {
      i++
      continue
    }

    // Paragraph
    const paraLines: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].match(/^#{1,6}\s/) && !lines[i].trimStart().startsWith("```") && !lines[i].trim().startsWith("|") && !lines[i].trimStart().startsWith(">") && !lines[i].match(/^\s*[-*+]\s+/) && !lines[i].match(/^\s*\d+\.\s+/)) {
      paraLines.push(lines[i])
      i++
    }
    html.push(`<p class="md-p">${paraLines.map(l => renderInline(l)).join("<br>")}</p>`)
  }

  // Flush remaining
  if (inCode) flushCode()
  if (inTable) flushTable()
  if (inList) flushList()

  return html.join("\n")
}

/* ── Reading Progress Bar ──────────────────────────────────────────────────── */

function ReadingProgress() {
  const [progress, setProgress] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleScroll = () => {
      const el = contentRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const total = rect.height - window.innerHeight
      const scrolled = -rect.top
      const pct = Math.min(100, Math.max(0, (scrolled / total) * 100))
      setProgress(pct)
    }
    window.addEventListener("scroll", handleScroll, { passive: true })
    handleScroll()
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <div className="sp-progress-bar" ref={contentRef}>
      <div className="sp-progress-fill" style={{ width: `${progress}%` }} />
    </div>
  )
}

/* ── Table of Contents ─────────────────────────────────────────────────────── */

function extractHeadings(md: string): { level: number; text: string; id: string }[] {
  const headings: { level: number; text: string; id: string }[] = []
  const lines = md.split("\n")
  let inCode = false
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const m = line.match(/^(#{2,3})\s+(.*)$/)
    if (m) {
      const text = m[2].replace(/[*`#]/g, "").trim()
      const id = text.toLowerCase().replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fff-]/g, "")
      headings.push({ level: m[1].length, text, id })
    }
  }
  return headings
}

function TableOfContents({ headings }: { headings: { level: number; text: string; id: string }[] }) {
  const [active, setActive] = useState("")

  useEffect(() => {
    const handleScroll = () => {
      let current = ""
      for (const h of headings) {
        const el = document.getElementById(h.id)
        if (el) {
          const rect = el.getBoundingClientRect()
          if (rect.top <= 120) {
            current = h.id
          }
        }
      }
      setActive(current)
    }
    window.addEventListener("scroll", handleScroll, { passive: true })
    handleScroll()
    return () => window.removeEventListener("scroll", handleScroll)
  }, [headings])

  if (headings.length < 2) return null

  return (
    <nav className="sp-toc">
      <div className="sp-toc-title">目錄</div>
      {headings.map(h => (
        <a
          key={h.id}
          href={`#${h.id}`}
          className={`sp-toc-item sp-toc-h${h.level} ${active === h.id ? "active" : ""}`}
          onClick={(e) => {
            e.preventDefault()
            document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
          }}
        >
          {h.text}
        </a>
      ))}
    </nav>
  )
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */

export function SharePostPage() {
  const { postId } = useParams<{ postId: string }>()
  const [post, setPost] = useState<SharePost | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!postId) return
    setLoading(true)
    setError("")
    api<SharePost>(`/api/v1/share/posts/id/${postId}`)
      .then(setPost)
      .catch(() => setError("文章不存在或已下架"))
      .finally(() => setLoading(false))
  }, [postId])

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  if (loading) {
    return (
      <div className="sp-page">
        <div className="sp-loading">
          <div className="sp-loading-spinner" />
          <span>載入文章中…</span>
        </div>
        <style>{styles}</style>
      </div>
    )
  }

  if (error || !post) {
    return (
      <div className="sp-page">
        <div className="sp-error">
          <div className="sp-error-icon">📄</div>
          <h2>{error || "文章不存在"}</h2>
          <Link to="/" className="sp-back-link">← 回到首頁</Link>
        </div>
        <style>{styles}</style>
      </div>
    )
  }

  const html = renderMarkdown(post.content)
  const headings = extractHeadings(post.content)
  const readTime = Math.max(1, Math.round(post.content.length / 500))
  const isVideoPost = !!post.video_file

  return (
    <div className="sp-page">
      {/* Progress bar */}
      <div className="sp-progress-track">
        <ReadingProgress />
      </div>

      {/* Header */}
      <header className="sp-header">
        <div className="sp-header-inner">
          <Link to="/" className="sp-logo">
            <span className="sp-logo-mark">◈</span>
            <span className="sp-logo-text">OPS Control</span>
          </Link>
          <nav className="sp-nav">
            <a href="/">首頁</a>
            <a href="/admin/overview">控制台</a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <div className="sp-hero">
        <div className="sp-hero-inner">
          {post.source_type && (
            <span className={`sp-source-badge sp-source-${post.source_type}`}>
              {post.source_type === "note" ? "📝 筆記" : "🎨 AI 創作"}
            </span>
          )}
          <h1 className="sp-title">{post.title}</h1>
          <div className="sp-meta">
            <span className="sp-meta-item">
              <span className="sp-meta-avatar">{post.author?.[0]?.toUpperCase() ?? "A"}</span>
              {post.author}
            </span>
            <span className="sp-meta-dot">·</span>
            <span className="sp-meta-item">
              {post.published_at ? new Date(post.published_at).toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric" }) : ""}
            </span>
            <span className="sp-meta-dot">·</span>
            <span className="sp-meta-item">約 {readTime} 分鐘閱讀</span>
          </div>
          <button className="sp-copy-btn" onClick={handleCopyLink}>
            {copied ? "✓ 已複製" : "🔗 複製連結"}
          </button>
        </div>
      </div>

      {/* Video hero — for video posts, the video IS the hero */}
      {isVideoPost && (
        <div className="sp-video-hero">
          <video controls poster={coverUrl(post.cover_image)} preload="metadata">
            <source src={videoUrl(post.video_file)} type="video/mp4" />
            您的瀏覽器不支援影片播放
          </video>
        </div>
      )}

      {/* Cover image — only for non-video posts */}
      {!isVideoPost && post.cover_image && (
        <div className="sp-cover">
          <img src={coverUrl(post.cover_image)} alt={post.title} />
        </div>
      )}

      {/* Content + TOC */}
      <div className="sp-content-layout">
        <article className="sp-article">
          <div className="sp-article-body" dangerouslySetInnerHTML={{ __html: html }} />
        </article>

        {/* TOC sidebar */}
        <aside className="sp-sidebar">
          <TableOfContents headings={headings} />
        </aside>
      </div>

      {/* Footer nav */}
      <div className="sp-footer-nav">
        <Link to="/" className="sp-back-link">← 回到首頁</Link>
      </div>

      <footer className="sp-footer">
        <p>© {new Date().getFullYear()} OPS Control System · 技術分享</p>
      </footer>

      <style>{styles}</style>
    </div>
  )
}

/* ── Styles ────────────────────────────────────────────────────────────────── */

const styles = `
/* Reset & Base */
.sp-page {
  min-height: 100vh;
  background: #0a0a0f;
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", Roboto, sans-serif;
  line-height: 1.7;
}

/* Progress Bar */
.sp-progress-track {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(255,255,255,0.05);
  z-index: 100;
}
.sp-progress-bar {
  height: 100%;
  width: 100%;
}
.sp-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #6366f1, #8b5cf6, #a855f7);
  transition: width 0.1s ease-out;
  border-radius: 0 2px 2px 0;
}

/* Header */
.sp-header {
  position: sticky;
  top: 0;
  z-index: 50;
  background: rgba(10,10,15,0.85);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.sp-header-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sp-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: #e2e8f0;
  font-weight: 700;
  font-size: 16px;
}
.sp-logo-mark {
  color: #6366f1;
  font-size: 20px;
}
.sp-nav {
  display: flex;
  gap: 20px;
}
.sp-nav a {
  color: #94a3b8;
  text-decoration: none;
  font-size: 14px;
  transition: color 0.2s;
}
.sp-nav a:hover {
  color: #e2e8f0;
}

/* Hero */
.sp-hero {
  padding: 60px 24px 40px;
  text-align: center;
  background: linear-gradient(180deg, rgba(99,102,241,0.08) 0%, transparent 100%);
}
.sp-hero-inner {
  max-width: 800px;
  margin: 0 auto;
}
.sp-source-badge {
  display: inline-block;
  padding: 4px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 16px;
}
.sp-source-note {
  background: rgba(59,130,246,0.15);
  color: #60a5fa;
  border: 1px solid rgba(59,130,246,0.3);
}
.sp-source-comfyui {
  background: rgba(168,85,247,0.15);
  color: #c084fc;
  border: 1px solid rgba(168,85,247,0.3);
}
.sp-title {
  font-size: 42px;
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: -0.5px;
  margin: 0 0 20px;
  background: linear-gradient(135deg, #f1f5f9 0%, #94a3b8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.sp-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #64748b;
  font-size: 14px;
  margin-bottom: 20px;
}
.sp-meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sp-meta-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
}
.sp-meta-dot {
  color: #334155;
}
.sp-copy-btn {
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05);
  color: #94a3b8;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.sp-copy-btn:hover {
  background: rgba(255,255,255,0.1);
  color: #e2e8f0;
  border-color: rgba(255,255,255,0.2);
}

/* Video Hero — full-width video for video posts */
.sp-video-hero {
  max-width: 960px;
  margin: 0 auto 32px;
  padding: 0 24px;
}
.sp-video-hero video {
  width: 100%;
  display: block;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.08);
  background: #000;
  max-height: 540px;
}

/* Cover — for non-video posts */
.sp-cover {
  max-width: 900px;
  margin: 0 auto 32px;
  padding: 0 24px;
}
.sp-cover img {
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.08);
}

/* Content Layout */
.sp-content-layout {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px 60px;
  display: grid;
  grid-template-columns: 1fr 240px;
  gap: 48px;
  align-items: start;
}

/* Article */
.sp-article {
  min-width: 0;
}
.sp-article-body {
  font-size: 16px;
  line-height: 1.85;
  color: #cbd5e1;
}

/* Markdown Styles */
.md-p {
  margin: 0 0 20px;
}
.md-h1, .md-h2, .md-h3, .md-h4, .md-h5, .md-h6 {
  color: #f1f5f9;
  font-weight: 700;
  margin: 40px 0 16px;
  scroll-margin-top: 80px;
}
.md-h1 { font-size: 32px; }
.md-h2 {
  font-size: 24px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.md-h3 { font-size: 20px; }
.md-h4 { font-size: 17px; }
.md-h5, .md-h6 { font-size: 15px; }

.md-inline-code {
  background: rgba(99,102,241,0.12);
  color: #a5b4fc;
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 14px;
  font-family: "JetBrains Mono", "Fira Code", monospace;
  border: 1px solid rgba(99,102,241,0.2);
}

.md-code {
  background: #0d1117;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  margin: 20px 0;
  overflow: hidden;
}
.md-code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: rgba(255,255,255,0.03);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  font-size: 12px;
  color: #64748b;
  font-family: "JetBrains Mono", monospace;
}
.md-copy-btn {
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.1);
  background: transparent;
  color: #64748b;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.md-copy-btn:hover {
  background: rgba(255,255,255,0.08);
  color: #e2e8f0;
}
.md-code code {
  display: block;
  padding: 16px 20px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
  font-family: "JetBrains Mono", "Fira Code", monospace;
  color: #c9d1d9;
}

.md-table-wrap {
  overflow-x: auto;
  margin: 20px 0;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.08);
}
.md-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.md-table th {
  background: rgba(99,102,241,0.1);
  color: #a5b4fc;
  font-weight: 600;
  text-align: left;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.md-table td {
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  color: #cbd5e1;
}
.md-table tr:last-child td {
  border-bottom: none;
}
.md-table tr:hover td {
  background: rgba(255,255,255,0.02);
}

.md-list {
  margin: 0 0 20px;
  padding-left: 24px;
}
.md-list li {
  margin-bottom: 8px;
  color: #cbd5e1;
}
.md-list li::marker {
  color: #6366f1;
}

.md-blockquote {
  border-left: 3px solid #6366f1;
  padding: 12px 20px;
  margin: 20px 0;
  background: rgba(99,102,241,0.06);
  border-radius: 0 8px 8px 0;
  color: #94a3b8;
  font-style: italic;
}

.md-hr {
  border: none;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin: 32px 0;
}

/* TOC Sidebar */
.sp-sidebar {
  position: sticky;
  top: 80px;
}
.sp-toc {
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 12px;
  padding: 20px;
}
.sp-toc-title {
  font-size: 13px;
  font-weight: 700;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 12px;
}
.sp-toc-item {
  display: block;
  padding: 6px 10px;
  font-size: 13px;
  color: #64748b;
  text-decoration: none;
  border-radius: 6px;
  transition: all 0.2s;
  line-height: 1.4;
}
.sp-toc-item:hover {
  color: #e2e8f0;
  background: rgba(255,255,255,0.04);
}
.sp-toc-item.active {
  color: #a5b4fc;
  background: rgba(99,102,241,0.1);
}
.sp-toc-h3 {
  padding-left: 20px;
  font-size: 12px;
}

/* Footer Nav */
.sp-footer-nav {
  max-width: 800px;
  margin: 0 auto 40px;
  padding: 0 24px;
}
.sp-back-link {
  color: #6366f1;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: color 0.2s;
}
.sp-back-link:hover {
  color: #818cf8;
}

/* Footer */
.sp-footer {
  text-align: center;
  padding: 32px 24px;
  border-top: 1px solid rgba(255,255,255,0.06);
  color: #475569;
  font-size: 13px;
}

/* Loading */
.sp-loading {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #64748b;
}
.sp-loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(99,102,241,0.2);
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: sp-spin 0.8s linear infinite;
}
@keyframes sp-spin {
  to { transform: rotate(360deg); }
}

/* Error */
.sp-error {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #64748b;
}
.sp-error-icon {
  font-size: 48px;
}
.sp-error h2 {
  color: #e2e8f0;
  margin: 0;
}

/* Responsive */
@media (max-width: 900px) {
  .sp-content-layout {
    grid-template-columns: 1fr;
  }
  .sp-sidebar {
    display: none;
  }
  .sp-title {
    font-size: 28px;
  }
  .sp-hero {
    padding: 40px 16px 28px;
  }
  .sp-meta {
    flex-wrap: wrap;
  }
}
`
