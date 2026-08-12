import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../auth"
import { Summary, Health } from "../types"
import { useTranslation } from "react-i18next"

export function OverviewPage() {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<Summary>("/api/v1/inventory/summary").then(setSummary).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="empty">{t("common.loading")}</div>
  if (!summary) return <div className="empty">{t("overview.loadFailed")}</div>

  return (
    <>
      <div className="page-header">
        <div><h1>{t("overview.title")}</h1><p>{t("overview.subtitle")}</p></div>
      </div>

      <div className="stats-row">
        <div className="stat-card"><div className="stat-label">{t("overview.totalAssets")}</div><div className="stat-value">{summary.total}</div></div>
        <div className="stat-card"><div className="stat-label">{t("overview.healthy")}</div><div className="stat-value" style={{ color: "var(--success)" }}>{summary.by_health.healthy ?? 0}</div></div>
        <div className="stat-card"><div className="stat-label">{t("overview.needAttention")}</div><div className="stat-value" style={{ color: "var(--warning)" }}>{(summary.by_health.warning ?? 0) + (summary.by_health.critical ?? 0)}</div></div>
        <div className="stat-card"><div className="stat-label">{t("overview.unknown")}</div><div className="stat-value" style={{ color: "#94a3b8" }}>{summary.by_health.unknown ?? 0}</div></div>
      </div>

      <div className="card">
        <div className="card-header"><h2>{t("overview.envDistribution")}</h2></div>
        <div className="card-body">
          {Object.entries(summary.by_environment).map(([name, count]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span className={`tag tag-${name}`}>{name}</span>
              <strong style={{ marginLeft: "auto" }}>{count}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><h2>{t("overview.quickLinks")}</h2></div>
        <div className="card-body" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link to="/assets" className="btn">{t("overview.links.assets")}</Link>
          <Link to="/services" className="btn">{t("overview.links.services")}</Link>
          <Link to="/monitoring" className="btn">{t("overview.links.monitoring")}</Link>
          <Link to="/remote" className="btn">{t("overview.links.remote")}</Link>
        </div>
      </div>
    </>
  )
}
