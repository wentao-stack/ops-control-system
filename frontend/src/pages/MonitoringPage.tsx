import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../auth"
import { HostMetrics, RemoteHostMetric, RemoteHostsMetrics } from "../types"

function barColor(pct: number) {
  if (pct > 80) return "var(--danger)"
  if (pct > 50) return "var(--warning)"
  return "var(--success)"
}

function MetricBar({ label, value, max, unit, pct }: { label: string; value: string; max?: string; unit?: string; pct?: number }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
        <span style={{ color: "var(--text-secondary)" }}>{label}</span>
        <span style={{ fontWeight: 600 }}>{value}{unit ?? ""}</span>
      </div>
      {pct !== undefined && (
        <div style={{ height: 6, background: "#e2e8f0", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: barColor(pct), borderRadius: 3, transition: "width .3s" }} />
        </div>
      )}
    </div>
  )
}

function HostCard({ host, expanded, onToggle }: { host: RemoteHostMetric; expanded: boolean; onToggle: () => void }) {
  const memGB = (mb: number) => (mb / 1024).toFixed(1)
  const diskGB = (mb: number) => (mb / 1024 / 1024).toFixed(1)

  return (
    <div className="card" style={{ cursor: "pointer" }} onClick={onToggle}>
      <div className="card-header" style={{ background: host.reachable ? "transparent" : "#fef2f2" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: host.reachable ? "var(--success)" : "var(--danger)", boxShadow: host.reachable ? "0 0 6px rgba(34,197,94,.4)" : "none", flexShrink: 0 }} />
          <div>
            <h2 style={{ margin: 0 }}>{host.name}</h2>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{host.hostname} · {host.reachable ? "連線正常" : host.error || "無法連線"}</span>
          </div>
        </div>
        <span style={{ color: "var(--text-secondary)", fontSize: 12, transition: "transform .2s", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
      </div>

      {/* Summary row always visible */}
      <div style={{ padding: "12px 20px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, borderBottom: "1px solid var(--border)" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>CPU</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: barColor(host.cpu_percent) }}>{host.cpu_percent.toFixed(0)}%</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>記憶體</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: barColor(host.mem_percent) }}>{host.mem_percent.toFixed(0)}%</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>磁碟</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: barColor(host.disk_percent) }}>{host.disk_percent.toFixed(0)}%</div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="card-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>系統資源</h3>
              <MetricBar label="CPU 使用率" value={`${host.cpu_percent.toFixed(0)}%`} pct={host.cpu_percent} />
              <MetricBar label="CPU 核心數" value={`${host.cpu_count}`} />
              <MetricBar label="Load Average" value={`${host.load_avg_1.toFixed(2)} / ${host.load_avg_5.toFixed(2)} / ${host.load_avg_15.toFixed(2)}`} />
              <MetricBar label="記憶體" value={`${memGB(host.mem_used_mb)} / ${memGB(host.mem_total_mb)} GB`} pct={host.mem_percent} />
              <MetricBar label="Swap" value={`${memGB(host.swap_used_mb)} / ${memGB(host.swap_total_mb)} GB`} pct={host.swap_percent} />
            </div>
            <div>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>磁碟空間</h3>
              <MetricBar label="已使用" value={`${diskGB(host.disk_used_mb)} GB`} />
              <MetricBar label="總容量" value={`${diskGB(host.disk_total_mb)} GB`} />
              <MetricBar label="剩餘" value={`${diskGB(host.disk_free_mb)} GB`} />
              <MetricBar label="使用率" value={`${host.disk_percent.toFixed(0)}%`} pct={host.disk_percent} />
            </div>
          </div>

          {/* GPU section */}
          {host.gpus.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
                GPU — {host.gpus.length} 裝置
              </h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
                {host.gpus.map((gpu, i) => (
                  <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 14 }}>
                    <strong style={{ fontSize: 13 }}>{gpu.name}</strong>
                    <div style={{ marginTop: 8 }}>
                      <MetricBar label="溫度" value={`${gpu.temperature_c}°C`} />
                      <MetricBar label="使用率" value={`${gpu.utilization_gpu}%`} pct={gpu.utilization_gpu} />
                      <MetricBar label="VRAM" value={`${gpu.memory_used_mb} / ${gpu.memory_total_mb} MiB`} pct={gpu.memory_total_mb > 0 ? (gpu.memory_used_mb / gpu.memory_total_mb) * 100 : 0} />
                      <MetricBar label="功耗" value={`${gpu.power_draw_w.toFixed(0)} W`} />
                      <MetricBar label="風扇" value={`${gpu.fan_speed}%`} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <Link to={`/assets/${host.asset_id}`} className="btn btn-sm">📋 資產詳情</Link>
            <Link to="/remote" className="btn btn-sm">⌨ 遠程終端</Link>
          </div>
        </div>
      )}
    </div>
  )
}

export function MonitoringPage() {
  const [localMetrics, setLocalMetrics] = useState<HostMetrics | null>(null)
  const [remoteData, setRemoteData] = useState<RemoteHostMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [collectedAt, setCollectedAt] = useState("")

  const loadLocal = async () => {
    try { setLocalMetrics(await api<HostMetrics>("/api/v1/host/metrics")) }
    catch { /* silent */ }
  }

  const loadRemote = async () => {
    setCollecting(true)
    try {
      const data = await api<RemoteHostsMetrics>("/api/v1/hosts/metrics")
      setRemoteData(data.hosts)
      setCollectedAt(new Intl.DateTimeFormat("zh-Hant", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(data.collected_at)))
    } catch { /* silent */ } finally {
      setCollecting(false)
      setLoading(false)
    }
  }

  useEffect(() => { void loadLocal(); void loadRemote() }, [])

  return (
    <>
      <div className="page-header">
        <div>
          <h1>主機監控</h1>
          <p>
            本機: {localMetrics?.hostname ?? "—"} · 遠程: {remoteData.length} 台主機
            {collectedAt && ` · 收集於 ${collectedAt}`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm" onClick={() => { void loadLocal() }} disabled={collecting}>↻ 本機</button>
          <button className="btn btn-primary btn-sm" onClick={() => { void loadRemote() }} disabled={collecting}>
            {collecting ? "⠋ 收集中..." : "↻ 收集全部"}
          </button>
        </div>
      </div>

      {loading && <div className="empty">載入中…</div>}

      {/* Local host metrics */}
      {localMetrics && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--success)", boxShadow: "0 0 6px rgba(34,197,94,.4)" }} />
              <div>
                <h2 style={{ margin: 0 }}>本機 — {localMetrics.hostname}</h2>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>後端伺服器</span>
              </div>
            </div>
          </div>
          <div style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>CPU</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: barColor(localMetrics.cpu_percent) }}>{localMetrics.cpu_percent.toFixed(0)}%</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{localMetrics.cpu_count} 核心 · load {localMetrics.load_avg_1.toFixed(2)}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>記憶體</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: barColor(localMetrics.mem_percent) }}>{localMetrics.mem_percent.toFixed(0)}%</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{(localMetrics.mem_used_mb / 1024).toFixed(1)} / {(localMetrics.mem_total_mb / 1024).toFixed(1)} GiB</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>磁碟</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: barColor(localMetrics.disk_percent) }}>{localMetrics.disk_percent.toFixed(0)}%</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{(localMetrics.disk_used_mb / 1024 / 1024).toFixed(1)} / {(localMetrics.disk_total_mb / 1024 / 1024).toFixed(1)} TiB</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>運行時間</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{localMetrics.uptime_seconds > 86400 ? (localMetrics.uptime_seconds / 86400).toFixed(0) + " 天" : (localMetrics.uptime_seconds / 3600).toFixed(0) + " 小時"}</div>
            </div>
          </div>
          {localMetrics.gpus.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "16px 20px" }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
                GPU — {localMetrics.gpus.length} 裝置
              </h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
                {localMetrics.gpus.map((gpu, i) => (
                  <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 14 }}>
                    <strong style={{ fontSize: 13 }}>{gpu.name}</strong>
                    <div style={{ marginTop: 8 }}>
                      <MetricBar label="溫度" value={`${gpu.temperature_c}°C`} />
                      <MetricBar label="使用率" value={`${gpu.utilization_gpu}%`} pct={gpu.utilization_gpu} />
                      <MetricBar label="VRAM" value={`${gpu.memory_used_mb} / ${gpu.memory_total_mb} MiB`} pct={gpu.memory_total_mb > 0 ? (gpu.memory_used_mb / gpu.memory_total_mb) * 100 : 0} />
                      <MetricBar label="功耗" value={`${gpu.power_draw_w.toFixed(0)} W`} />
                      <MetricBar label="風扇" value={`${gpu.fan_speed}%`} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Remote hosts */}
      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        遠程主機
      </h2>

      {remoteData.length === 0 && !loading && (
        <div className="card"><div className="card-body"><p style={{ color: "var(--text-secondary)", fontSize: 13 }}>沒有可監控的遠程主機</p></div></div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {remoteData.map(host => (
          <HostCard
            key={host.asset_id}
            host={host}
            expanded={expandedId === host.asset_id}
            onToggle={() => setExpandedId(expandedId === host.asset_id ? null : host.asset_id)}
          />
        ))}
      </div>
    </>
  )
}
