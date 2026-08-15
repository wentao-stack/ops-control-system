import { useState } from "react"
import { useAuth } from "./AuthProvider"
import { Link, useLocation, Outlet } from "react-router-dom"
import { useTranslation } from "react-i18next"

const NAV_KEYS = [
  { to: "/", key: "nav.overview", icon: "📊" },
  { to: "/assets", key: "nav.assets", icon: "🖥" },
  { to: "/services", key: "nav.services", icon: "🔧" },
  { to: "/monitoring", key: "nav.monitoring", icon: "📡" },
  { to: "/remote", key: "nav.remote", icon: "⌨" },
  { to: "/clouds", key: "nav.clouds", icon: "☁" },
  { to: "/notes", key: "nav.notes", icon: "📝" },
  { to: "/workflow", key: "nav.workflow", icon: "🔄" },
  { to: "/agent", key: "nav.agent", icon: "🤖" },
  { to: "/comfyui", key: "nav.comfyui", icon: "🎨" },
  { to: "/sequence-studio", key: "nav.sequence", icon: "🎞" },
  { to: "/code", key: "nav.code", icon: "📂" },
  { to: "/settings", key: "nav.settings", icon: "⚙" },
]

export function Layout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const { t, i18n } = useTranslation()
  const nav = NAV_KEYS.map(item => ({ ...item, label: t(item.key) }))
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
          <button className="logout-btn" onClick={logout} title={t("layout.logout")}>→</button>
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
