import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../auth"
import { Summary, Health } from "../types"

export function OverviewPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<Summary>("/api/v1/inventory/summary").then(setSummary).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="empty">載入中…</div>
  if (!summary) return <div className="empty">無法載入資料</div>

  return (
    <>
      <div className="page-header">
        <div><h1>系統概覽</h1><p>即時掌握基礎設施狀態</p></div>
      </div>

      <div className="stats-row">
        <div className="stat-card"><div className="stat-label">總資產數</div><div className="stat-value">{summary.total}</div></div>
        <div className="stat-card"><div className="stat-label">正常</div><div className="stat-value" style={{ color: "var(--success)" }}>{summary.by_health.healthy ?? 0}</div></div>
        <div className="stat-card"><div className="stat-label">需關注</div><div className="stat-value" style={{ color: "var(--warning)" }}>{(summary.by_health.warning ?? 0) + (summary.by_health.critical ?? 0)}</div></div>
        <div className="stat-card"><div className="stat-label">未知</div><div className="stat-value" style={{ color: "#94a3b8" }}>{summary.by_health.unknown ?? 0}</div></div>
      </div>

      <div className="card">
        <div className="card-header"><h2>環境分佈</h2></div>
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
        <div className="card-header"><h2>快速連結</h2></div>
        <div className="card-body" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link to="/assets" className="btn">🖥 資產清單</Link>
          <Link to="/monitoring" className="btn">📡 主機監控</Link>
          <Link to="/remote" className="btn">⌨ 遠程終端</Link>
        </div>
      </div>
    </>
  )
}
