import { useState } from "react"
import { useAuth } from "./AuthProvider"
import { Link, useLocation, Outlet, Navigate } from "react-router-dom"
import { useTranslation } from "react-i18next"

const NAV_KEYS = [
  { to: "/admin/overview", key: "nav.overview", icon: "📊" },
  { to: "/admin/assets", key: "nav.assets", icon: "🖥" },
  { to: "/admin/services", key: "nav.services", icon: "🔧" },
  { to: "/admin/monitoring", key: "nav.monitoring", icon: "📡" },
  { to: "/admin/remote", key: "nav.remote", icon: "⌨" },
  { to: "/admin/clouds", key: "nav.clouds", icon: "☁" },
  { to: "/admin/notes", key: "nav.notes", icon: "📝" },
  { to: "/admin/workflow", key: "nav.workflow", icon: "🔄" },
  { to: "/admin/agent", key: "nav.agent", icon: "🤖" },
  { to: "/admin/comfyui", key: "nav.comfyui", icon: "🎨" },
  { to: "/admin/sequence-studio", key: "nav.sequence", icon: "🎞" },
  { to: "/admin/code", key: "nav.code", icon: "📂" },
  { to: "/admin/settings", key: "nav.settings", icon: "⚙" },
]

export function AdminLayout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const { t, i18n } = useTranslation()
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("sidebar-collapsed") === "1" } catch { return false }
  })
  const rawTitle = t(`pageTitle${location.pathname}`)
  const title = rawTitle === `pageTitle${location.pathname}` ? t("app.name") : rawTitle
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
          {!collapsed && <span>{t("app.name")}</span>}
        </div>
        <button className="sidebar-toggle" onClick={toggle} title={collapsed ? t("layout.expand") : t("layout.collapse")}>
          {collapsed ? "▶" : "◀"}
        </button>
        <nav>
          {NAV_KEYS.map(n => {
            const label = t(n.key)
            return (
              <Link
                key={n.to}
                to={n.to}
                className={location.pathname === n.to ? "active" : ""}
                title={collapsed ? label : undefined}
              >
                <span className="nav-icon">{n.icon}</span>
                {!collapsed && <span>{label}</span>}
              </Link>
            )
          })}
        </nav>
        <div className="sidebar-user">
          <div className="user-avatar">{user?.display_name?.[0]?.toUpperCase() ?? "?"}</div>
          {!collapsed && (
            <div className="user-info">
              <span className="user-name">{user?.display_name ?? "User"}</span>
              <span className="user-role">{user?.role ?? ""}</span>
            </div>
          )}
          <button className="logout-btn" onClick={logout} title={t("layout.logout")}>=&gt;</button>
        </div>
      </aside>
      <div className={`content ${collapsed ? "content--expanded" : ""}`}>
        <div className="topbar">
          <div>
            <div className="topbar-title">{title}</div>
            <div className="topbar-breadcrumb">{t("layout.breadcrumb")} {NAV_KEYS.find(n => n.to === location.pathname) ? t(NAV_KEYS.find(n => n.to === location.pathname)!.key) : title}</div>
          </div>
          <div className="topbar-actions">
            <button
              className="btn btn-sm"
              onClick={() => {
                const langs = ["zh-TW", "en", "ja"];
                const idx = langs.indexOf(i18n.language);
                const next = langs[(idx + 1) % langs.length];
                i18n.changeLanguage(next);
              }}
              title="切换语言"
            >
              {t(`lang.${i18n.language}`)}
            </button>
            <button className="btn btn-sm" onClick={() => window.location.reload()}>{t("app.reload")}</button>
          </div>
        </div>
        <div className="page">
          <Outlet />
        </div>
      </div>
    </div>
  )
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export function RequireAuthOutlet() {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}
