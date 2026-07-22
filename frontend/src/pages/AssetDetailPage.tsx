import { useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { api } from "../auth"
import { AssetDetail, Health, HEALTH_LABELS, fmt } from "../types"

function StatusPill({ status }: { status: Health }) {
  return <span className={`status status-${status}`}><i /><span>{HEALTH_LABELS[status]}</span></span>
}

export function AssetDetailPage() {
  const { assetId } = useParams<{ assetId: string }>()
  const navigate = useNavigate()
  const [asset, setAsset] = useState<AssetDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!assetId) return
    setLoading(true)
    api<AssetDetail>(`/api/v1/assets/${assetId}`).then(setAsset).catch(() => navigate("/assets")).finally(() => setLoading(false))
  }, [assetId])

  if (loading) return <div className="empty">載入中…</div>
  if (!asset) return <div className="empty">資產不存在</div>

  return (
    <>
      <div className="page-header">
        <div>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
            <Link to="/assets" style={{ color: "var(--primary)" }}>資產</Link> / {asset.name}
          </p>
          <h1>{asset.name}</h1>
        </div>
        <button className="btn" onClick={() => navigate(-1)}>← 返回</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Basic Info */}
        <div className="card">
          <div className="card-header"><h2>基本資訊</h2></div>
          <div className="card-body">
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              <span className="tag">{asset.asset_type}</span>
              <span className={`tag tag-${asset.environment}`}>{asset.environment}</span>
              <span className={`tag criticality-${asset.criticality}`}>{asset.criticality}</span>
            </div>
            <StatusPill status={asset.health_status} />
            <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>{asset.health_summary}</p>
            <dl style={{ display: "grid", gap: 10, marginTop: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                <dt style={{ color: "var(--text-secondary)", fontSize: 12 }}>負責人</dt>
                <dd style={{ fontSize: 12 }}>{asset.owner}</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                <dt style={{ color: "var(--text-secondary)", fontSize: 12 }}>最後偵測</dt>
                <dd style={{ fontSize: 12 }}>{fmt(asset.last_seen_at)}</dd>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                <dt style={{ color: "var(--text-secondary)", fontSize: 12 }}>資產 ID</dt>
                <dd style={{ fontSize: 12, fontFamily: "monospace" }}>{asset.id}</dd>
              </div>
            </dl>
          </div>
        </div>

        {/* SSH Info */}
        <div className="card">
          <div className="card-header"><h2>SSH 連線</h2></div>
          <div className="card-body">
            {asset.ssh_host ? (
              <>
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                    <dt style={{ color: "var(--text-secondary)", fontSize: 12 }}>Host</dt>
                    <dd style={{ fontSize: 12, fontFamily: "monospace" }}>{asset.ssh_host}</dd>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                    <dt style={{ color: "var(--text-secondary)", fontSize: 12 }}>Port</dt>
                    <dd style={{ fontSize: 12, fontFamily: "monospace" }}>{asset.ssh_port ?? 22}</dd>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                    <dt style={{ color: "var(--text-secondary)", fontSize: 12 }}>User</dt>
                    <dd style={{ fontSize: 12, fontFamily: "monospace" }}>{asset.ssh_user}</dd>
                  </div>
                </div>
                <div style={{ marginTop: 16, background: "#f8fafc", borderRadius: 6, padding: 12, fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                  <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>SSH 命令:</div>
                  <code>ssh {asset.ssh_user}@{asset.ssh_host} -p {asset.ssh_port ?? 22}</code>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Link to="/remote" className="btn btn-primary btn-sm">⌨ 前往遠程終端</Link>
                </div>
              </>
            ) : (
              <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>此資產未設定 SSH 連線資訊</p>
            )}
          </div>
        </div>
      </div>

      {/* Services */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><h2>關聯服務</h2></div>
        <div className="card-body">
          {asset.services.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {asset.services.map(s => (
                <div key={s.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <strong style={{ fontSize: 13 }}>{s.name}</strong>
                    <span className="tag" style={{ marginLeft: 8 }}>{s.service_type}</span>
                    <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{s.status_summary}</p>
                  </div>
                  <StatusPill status={s.status} />
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>無關聯服務</p>
          )}
        </div>
      </div>
    </>
  )
}
