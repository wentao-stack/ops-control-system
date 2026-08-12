import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { api } from "../auth"
import { Asset, Health, fmt } from "../types"
import { useTranslation } from "react-i18next"

function StatusPill({ status, t }: { status: Health; t: (k:string)=>string }) {
  return <span className={`status status-${status}`}><i /><span>{t(`health.${status}`)}</span></span>
}

export function AssetsPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [assets, setAssets] = useState<Asset[]>([])
  const [query, setQuery] = useState("")
  const [envFilter, setEnvFilter] = useState("")
  const [healthFilter, setHealthFilter] = useState("")
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (query) p.set("q", query)
      if (envFilter) p.set("environment", envFilter)
      if (healthFilter) p.set("health", healthFilter)
      const r = await api<{ items: Asset[] }>(`/api/v1/assets?${p}`)
      setAssets(r.items)
    } catch { /* silent */ } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [query, envFilter, healthFilter])

  return (
    <>
      <div className="page-header">
        <div><h1>{t("assets.title")}</h1><p>{t("assets.total").replace("{{count}}", String(assets.length))}</p></div>
      </div>

      <div className="filters">
        <input className="search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder={t("assets.searchPlaceholder")} />
        <select value={envFilter} onChange={e => setEnvFilter(e.target.value)}>
          <option value="">{t("assets.envAll")}</option>
          <option value="production">{t("env.production")}</option>
          <option value="staging">{t("env.staging")}</option>
          <option value="development">{t("env.development")}</option>
        </select>
        <select value={healthFilter} onChange={e => setHealthFilter(e.target.value)}>
          <option value="">{t("assets.healthAll")}</option>
          {(["healthy","warning","critical","unknown"] as Health[]).map(k => <option key={k} value={k}>{t(`health.${k}`)}</option>)}
        </select>
        {(query || envFilter || healthFilter) && (
          <button className="btn btn-sm" onClick={() => { setQuery(""); setEnvFilter(""); setHealthFilter("") }}>{t("assets.clearFilter")}</button>
        )}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>{t("assets.columns.name")}</th><th>{t("assets.columns.type")}</th><th>{t("assets.columns.env")}</th><th>{t("assets.columns.owner")}</th><th>{t("assets.columns.criticality")}</th><th>{t("assets.columns.status")}</th><th>{t("assets.columns.lastSeen")}</th></tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="empty">{t("assets.loading")}</td></tr>
              ) : assets.length === 0 ? (
                <tr><td colSpan={7} className="empty">{t("assets.empty")}</td></tr>
              ) : assets.map(a => (
                <tr key={a.id} onClick={() => navigate(`/assets/${a.id}`)} style={{ cursor: "pointer" }}>
                  <td><strong>{a.name}</strong></td>
                  <td><span className="tag">{a.asset_type}</span></td>
                  <td><span className={`tag tag-${a.environment}`}>{a.environment}</span></td>
                  <td>{a.owner}</td>
                  <td><span className={`tag criticality-${a.criticality}`}>{a.criticality}</span></td>
                  <td><StatusPill status={a.health_status} t={t} /></td>
                  <td style={{ color: "var(--text-secondary)", fontSize: 12 }}>{fmt(a.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
