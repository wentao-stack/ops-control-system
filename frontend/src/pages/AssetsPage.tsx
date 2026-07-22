import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { api } from "../auth"
import { Asset, AssetDetail, Health, HEALTH_LABELS, fmt } from "../types"

function StatusPill({ status }: { status: Health }) {
  return <span className={`status status-${status}`}><i /><span>{HEALTH_LABELS[status]}</span></span>
}

export function AssetsPage() {
  const navigate = useNavigate()
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
        <div><h1>資產清單</h1><p>共 {assets.length} 筆資產</p></div>
      </div>

      <div className="filters">
        <input className="search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋名稱..." />
        <select value={envFilter} onChange={e => setEnvFilter(e.target.value)}>
          <option value="">所有環境</option>
          <option value="production">Production</option>
          <option value="staging">Staging</option>
          <option value="development">Development</option>
        </select>
        <select value={healthFilter} onChange={e => setHealthFilter(e.target.value)}>
          <option value="">所有狀態</option>
          {Object.entries(HEALTH_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {(query || envFilter || healthFilter) && (
          <button className="btn btn-sm" onClick={() => { setQuery(""); setEnvFilter(""); setHealthFilter("") }}>清除篩選</button>
        )}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>名稱</th><th>類型</th><th>環境</th><th>負責人</th><th>重要度</th><th>狀態</th><th>最後偵測</th></tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="empty">載入中…</td></tr>
              ) : assets.length === 0 ? (
                <tr><td colSpan={7} className="empty">沒有符合條件的資產</td></tr>
              ) : assets.map(a => (
                <tr key={a.id} onClick={() => navigate(`/assets/${a.id}`)} style={{ cursor: "pointer" }}>
                  <td><strong>{a.name}</strong></td>
                  <td><span className="tag">{a.asset_type}</span></td>
                  <td><span className={`tag tag-${a.environment}`}>{a.environment}</span></td>
                  <td>{a.owner}</td>
                  <td><span className={`tag criticality-${a.criticality}`}>{a.criticality}</span></td>
                  <td><StatusPill status={a.health_status} /></td>
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
