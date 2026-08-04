import { useState } from "react"
import { useAuth } from "./AuthProvider"
import { Link, useLocation, Outlet } from "react-router-dom"

const NAV = [
  { to: "/", label: "總覽", icon: "📊" },
  { to: "/assets", label: "資產", icon: "🖥" },
  { to: "/services", label: "服務", icon: "🔧" },
  { to: "/monitoring", label: "監控", icon: "📡" },
  { to: "/remote", label: "終端", icon: "⌨" },
  { to: "/clouds", label: "雲端", icon: "☁" },
  { to: "/notes", label: "筆記", icon: "📝" },
  { to: "/workflow", label: "流程", icon: "🔄" },
  { to: "/agent", label: "助手", icon: "🤖" },
  { to: "/code", label: "代碼", icon: "📂" },
  { to: "/settings", label: "設定", icon: "⚙" },
]

const PAGE_TITLES: Record<string, string> = {
  "/": "儀表板總覽",
  "/assets": "資產管理",
  "/services": "服務總覽",
  "/monitoring": "主機監控",
  "/remote": "終端",
  "/clouds": "雲端管理",
  "/notes": "筆記管理",
  "/workflow": "流程管理",
  "/agent": "AI 助手",
  "/code": "代碼瀏覽器",
  "/settings": "系統設定",
}

export function Layout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("sidebar-collapsed") === "1" } catch { return false }
  })
  const title = PAGE_TITLES[location.pathname] ?? "OPS Control"

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem("sidebar-collapsed", next ? "1" : "0") } catch {}
  }

  return (
    <div className="shell">
      <aside className={`sidebar ${collapsed ? "sidebar--collapsed" : ""}`}>
        <div className="brand">
          <span className="brand-mark">◆</span>
          {!collapsed && <span>OPS CONTROL</span>}
        </div>
        <button className="sidebar-toggle" onClick={toggle} title={collapsed ? "展開" : "收縮"}>
          {collapsed ? "▶" : "◀"}
        </button>
        <nav>
          {NAV.map(n => (
            <Link
              key={n.to}
              to={n.to}
              className={location.pathname === n.to ? "active" : ""}
              title={collapsed ? n.label : undefined}
            >
              <span className="nav-icon">{n.icon}</span>
              {!collapsed && <span>{n.label}</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="user-avatar">{user?.display_name?.[0]?.toUpperCase() ?? "?"}</div>
          {!collapsed && (
            <div className="user-info">
              <span className="user-name">{user?.display_name ?? "User"}</span>
              <span className="user-role">{user?.role ?? ""}</span>
            </div>
          )}
          <button className="logout-btn" onClick={logout} title="登出">→</button>
        </div>
      </aside>
      <div className={`content ${collapsed ? "content--expanded" : ""}`}>
        <div className="topbar">
          <div>
            <div className="topbar-title">{title}</div>
            <div className="topbar-breadcrumb">OPS Control System / {NAV.find(n => n.to === location.pathname)?.label ?? title}</div>
          </div>
          <div className="topbar-actions">
            <button className="btn btn-sm" onClick={() => window.location.reload()}>↻ 重新整理</button>
          </div>
        </div>
        <div className="page">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
