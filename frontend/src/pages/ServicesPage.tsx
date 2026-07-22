import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../auth"
import { GPUMetric } from "../types"

type ServiceItem = {
  name: string; service_type: string; status: string;
  pid: string; ports: string; description: string; uptime: string;
}

type HostServices = {
  asset_id: string; name: string; hostname: string;
  reachable: boolean; services: ServiceItem[];
}

type AllServices = {
  hosts: HostServices[]; collected_at: string;
}

const TYPE_ICONS: Record<string, string> = {
  "reverse-proxy": "🔄",
  "web-server": "🌐",
  "ssh": "🔑",
  "container": "📦",
  "ai-inference": "🤖",
  "ai-agent": "🧠",
  "database": "🗄",
  "security": "🛡",
  "runtime": "⚡",
  "docker-container": "🐳",
}

const TYPE_COLORS: Record<string, string> = {
  "reverse-proxy": "#6366f1",
  "web-server": "#10b981",
  "ssh": "#f59e0b",
  "container": "#8b5cf6",
  "ai-inference": "#ec4899",
  "ai-agent": "#06b6d4",
  "database": "#3b82f6",
  "security": "#ef4444",
  "runtime": "#f97316",
  "docker-container": "#2563eb",
}

function ServiceBadge({ svc }: { svc: ServiceItem }) {
  const icon = TYPE_ICONS[svc.service_type] ?? "📌"
  const color = TYPE_COLORS[svc.service_type] ?? "#6b7280"
  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: 8,
      padding: "12px 16px",
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      background: "#fafbfc",
    }}>
      <span style={{ fontSize: 20, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 13 }}>{svc.name}</strong>
          <span style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 4,
            background: color + "18",
            color: color,
            fontWeight: 600,
          }}>
            {svc.service_type}
          </span>
          <span style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 4,
            background: svc.status === "running" ? "#dcfce7" : "#fef2f2",
            color: svc.status === "running" ? "#166534" : "#991b1b",
            fontWeight: 600,
          }}>
            {svc.status}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
          {svc.description}
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11, color: "var(--text-secondary)" }}>
          {svc.pid && <span>PID: {svc.pid}</span>}
          {svc.ports && <span>Ports: {svc.ports}</span>}
        </div>
      </div>
    </div>
  )
}

export function ServicesPage() {
  const [data, setData] = useState<HostServices[]>([])
  const [loading, setLoading] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [collectedAt, setCollectedAt] = useState("")

  const load = async () => {
    setCollecting(true)
    try {
      const all = await api<AllServices>("/api/v1/hosts/services")
      setData(all.hosts)
      setCollectedAt(new Intl.DateTimeFormat("zh-Hant", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).format(new Date(all.collected_at)))
    } catch { /* silent */ } finally {
      setCollecting(false)
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const totalServices = data.reduce((sum, h) => sum + h.services.length, 0)

  return (
    <>
      <div className="page-header">
        <div>
          <h1>服務總覽</h1>
          <p>
            {data.length} 台主機 · {totalServices} 個服務
            {collectedAt && ` · 收集於 ${collectedAt}`}
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => { void load() }} disabled={collecting}>
          {collecting ? "⠋ 偵測中..." : "↻ 重新偵測"}
        </button>
      </div>

      {loading && <div className="empty">載入中…</div>}

      {data.length === 0 && !loading && (
        <div className="card"><div className="card-body"><p style={{ color: "var(--text-secondary)", fontSize: 13 }}>沒有可偵測的遠程主機</p></div></div>
      )}

      <div style={{ display: "grid", gap: 16 }}>
        {data.map(host => (
          <div className="card" key={host.asset_id}>
            <div className="card-header">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: "50%",
                  background: host.reachable ? "var(--success)" : "var(--danger)",
                  boxShadow: host.reachable ? "0 0 6px rgba(34,197,94,.4)" : "none",
                  flexShrink: 0,
                }} />
                <div>
                  <h2 style={{ margin: 0 }}>{host.name}</h2>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {host.hostname} · {host.services.length} 個服務
                  </span>
                </div>
              </div>
              <Link to={`/assets/${host.asset_id}`} className="btn btn-sm">詳情</Link>
            </div>
            <div className="card-body">
              {host.services.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>未偵測到已知服務</p>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 8 }}>
                  {host.services.map((svc, i) => (
                    <ServiceBadge key={i} svc={svc} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
