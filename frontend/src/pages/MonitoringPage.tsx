import { useEffect, useState, useRef, useCallback } from "react"
import { Link } from "react-router-dom"
import { api } from "../auth"
import { HostMetrics, RemoteHostMetric, RemoteHostsMetrics } from "../types"

const REFRESH_INTERVAL = 30_000 // 30s auto-refresh

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
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{host.hostname || host.asset_id} · {host.reachable ? "連線正常" : host.error || "無法連線"}</span>
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
            <Link to="/remote" className="btn btn-sm">⌨ 終端</Link>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Skeleton loader ── */
function SkeletonCard() {
  return (
    <div className="card" style={{ pointerEvents: "none" }}>
      <div className="card-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#e2e8f0" }} />
          <div>
            <div style={{ height: 16, width: 120, background: "#e2e8f0", borderRadius: 4, marginBottom: 4 }} />
            <div style={{ height: 10, width: 160, background: "#f1f5f9", borderRadius: 4 }} />
          </div>
        </div>
      </div>
      <div style={{ padding: "12px 20px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, borderBottom: "1px solid var(--border)" }}>
        {[1, 2, 3].map(i => (
          <div key={i} style={{ textAlign: "center" }}>
            <div style={{ height: 10, width: 30, background: "#f1f5f9", borderRadius: 4, margin: "0 auto 4px" }} />
            <div style={{ height: 20, width: 40, background: "#e2e8f0", borderRadius: 4, margin: "0 auto" }} />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Metrics History Panel ─────────────────────────────────────────────────── */

type ChartPoint = { t: string; v: number }
type HistoryRecord = {
  id: number; asset_id: string; hostname: string;
  cpu_percent: number; cpu_count: number;
  load_avg_1: number; load_avg_5: number; load_avg_15: number;
  mem_total_mb: number; mem_used_mb: number; mem_available_mb: number; mem_percent: number;
  swap_total_mb: number; swap_used_mb: number; swap_percent: number;
  disk_total_mb: number; disk_used_mb: number; disk_free_mb: number; disk_percent: number;
  gpus: any[]; collected_at: string;
}

function MiniChart({ data, color, height = 60 }: { data: ChartPoint[]; color: string; height?: number }) {
  if (data.length < 2) return <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", fontSize: 12 }}>資料不足</div>
  const maxV = Math.max(...data.map(d => d.v), 100)
  const w = 400
  const pts = data.map((d, i) => `${(i / (data.length - 1)) * w},${height - (d.v / maxV) * (height - 4)}`).join(" ")
  const area = `0,${height} ${pts} ${w},${height}`
  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      <polygon points={area} fill={color} opacity={0.15} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  )
}

function MetricsHistoryPanel({ assets }: { assets: RemoteHostMetric[] }) {
  const [assetId, setAssetId] = useState(assets[0]?.asset_id || "")
  const [metric, setMetric] = useState<"cpu" | "mem" | "disk" | "swap">("cpu")
  const [hours, setHours] = useState(24)
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [stats, setStats] = useState({ total: 0, earliest: "", latest: "" })
  const [loading, setLoading] = useState(false)

  const loadChart = useCallback(async () => {
    if (!assetId) return
    setLoading(true)
    try {
      const data = await api<any>(`/api/v1/metrics/history/chart?asset_id=${assetId}&metric=${metric}&hours=${hours}`)
      setChartData(data.data || [])
    } catch { /* silent */ } finally {
      setLoading(false)
    }
  }, [assetId, metric, hours])

  const loadRecords = useCallback(async () => {
    if (!assetId) return
    try {
      const data = await api<any>(`/api/v1/metrics/history?asset_id=${assetId}&limit=20`)
      setRecords(data.records || [])
      setStats({ total: data.total || 0, earliest: data.earliest || "", latest: data.latest || "" })
    } catch { /* silent */ }
  }, [assetId])

  useEffect(() => { void loadChart() }, [loadChart])
  useEffect(() => { void loadRecords() }, [loadRecords])

  const METRIC_LABELS: Record<string, string> = { cpu: "CPU", mem: "記憶體", disk: "磁碟", swap: "Swap" }
  const CHART_COLORS: Record<string, string> = { cpu: "#3b82f6", mem: "#f59e0b", disk: "#10b981", swap: "#8b5cf6" }
  const metricLabel = METRIC_LABELS[metric]
  const chartColor = CHART_COLORS[metric]

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <span style={{ fontSize: 14, fontWeight: 600 }}>📈 歷史監控數據</span>
      </div>
      <div className="card-body">
        {/* Controls */}
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <select value={assetId} onChange={e => setAssetId(e.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
            {assets.map(a => <option key={a.asset_id} value={a.asset_id}>{a.name} ({a.hostname})</option>)}
          </select>
          <div style={{ display: "flex", gap: 4 }}>
            {(["cpu", "mem", "disk", "swap"] as const).map(m => (
              <button key={m} className="btn btn-sm" style={{ background: metric === m ? CHART_COLORS[m] : "transparent", color: metric === m ? "#fff" : "var(--text)", border: `1px solid ${metric === m ? CHART_COLORS[m] : "var(--border)"}` }} onClick={() => setMetric(m)}>{METRIC_LABELS[m]}</button>
            ))}
          </div>
          <select value={hours} onChange={e => setHours(Number(e.target.value))} style={selectStyle}>
            <option value={1}>1 小時</option>
            <option value={6}>6 小時</option>
            <option value={12}>12 小時</option>
            <option value={24}>24 小時</option>
            <option value={48}>48 小時</option>
            <option value={168}>7 天</option>
          </select>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            共 {stats.total} 筆 · {stats.earliest ? new Date(stats.earliest).toLocaleDateString("zh-Hant") : "—"} ~ {stats.latest ? new Date(stats.latest).toLocaleDateString("zh-Hant") : "—"}
          </span>
        </div>

        {/* Chart */}
        <div style={{ marginBottom: 16, background: "var(--surface)", borderRadius: 8, padding: 12, border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>{metricLabel} 使用率 (%) — {hours}小時</div>
          {loading ? <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>載入中...</div> : <MiniChart data={chartData} color={chartColor} />}
        </div>

        {/* Recent records table */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>時間</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>CPU%</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>記憶體%</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>磁碟%</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Swap%</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Load</th>
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "4px 8px" }}>{new Date(r.collected_at).toLocaleString("zh-Hant")}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: barColor(r.cpu_percent) }}>{r.cpu_percent.toFixed(1)}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: barColor(r.mem_percent) }}>{r.mem_percent.toFixed(1)}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: barColor(r.disk_percent) }}>{r.disk_percent.toFixed(1)}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: barColor(r.swap_percent) }}>{r.swap_percent.toFixed(1)}</td>
                  <td style={{ padding: "4px 8px" }}>{r.load_avg_1.toFixed(2)}</td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)" }}>暫無歷史數據（每次收集監控數據時自動保存）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const selectStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 13 }

export function MonitoringPage() {
  const [tab, setTab] = useState<"live" | "history">("live")
  const [localMetrics, setLocalMetrics] = useState<HostMetrics | null>(null)
  const [remoteData, setRemoteData] = useState<RemoteHostMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [collectedAt, setCollectedAt] = useState("")
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadLocal = useCallback(async () => {
    try { setLocalMetrics(await api<HostMetrics>("/api/v1/host/metrics")) }
    catch { /* silent */ }
  }, [])

  const loadRemote = useCallback(async (useCache = false) => {
    if (useCache) {
      try {
        const data = await api<RemoteHostsMetrics>("/api/v1/hosts/metrics?cache=true")
        setRemoteData(data.hosts)
        setCollectedAt(new Intl.DateTimeFormat("zh-Hant", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(data.collected_at)))
        setLoading(false)
      } catch { /* silent */ }
      return
    }
    setCollecting(true)
    try {
      const data = await api<RemoteHostsMetrics>("/api/v1/hosts/metrics")
      setRemoteData(data.hosts)
      setCollectedAt(new Intl.DateTimeFormat("zh-Hant", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(data.collected_at)))
    } catch { /* silent */ } finally {
      setCollecting(false)
      setLoading(false)
    }
  }, [])

  // Auto-refresh every 30s using cache
  useEffect(() => {
    timerRef.current = setInterval(() => {
      void loadRemote(true)
    }, REFRESH_INTERVAL)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [loadRemote])

  // Initial load: cached first for speed, then fresh
  useEffect(() => {
    void loadLocal()
    void loadRemote(true) // fast cached load
    void loadRemote(false) // then fresh data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", background: "var(--surface)", borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button className="btn btn-sm" style={{ background: tab === "live" ? "var(--primary)" : "transparent", color: tab === "live" ? "#fff" : "var(--text)", border: "none", padding: "6px 14px" }} onClick={() => setTab("live")}>即時</button>
            <button className="btn btn-sm" style={{ background: tab === "history" ? "var(--primary)" : "transparent", color: tab === "history" ? "#fff" : "var(--text)", border: "none", borderLeft: "1px solid var(--border)", padding: "6px 14px" }} onClick={() => setTab("history")}>歷史</button>
          </div>
          {tab === "live" && (
            <>
              <button className="btn btn-sm" onClick={() => { void loadLocal() }} disabled={collecting}>↻ 本機</button>
              <button className="btn btn-primary btn-sm" onClick={() => { void loadRemote(false) }} disabled={collecting}>
                {collecting ? "⠋ 收集中..." : "↻ 收集全部"}
              </button>
            </>
          )}
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

      {loading && (
        <div style={{ display: "grid", gap: 12 }}>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

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
      {tab === "history" && <MetricsHistoryPanel assets={remoteData} />}
    </>
  )
}
