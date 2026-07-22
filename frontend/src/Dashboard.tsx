import { useEffect, useMemo, useState } from "react"
import { useAuth } from "./AuthProvider"
import { api } from "./auth"

/* ── Types ─────────────────────────────────────────────────────────────────── */

type Health = "healthy" | "warning" | "critical" | "unknown"
type Asset = {
  id: string; name: string; asset_type: string; environment: string;
  owner: string; criticality: string; health_status: Health;
  health_summary: string | null; last_seen_at: string | null;
  ssh_host?: string | null; ssh_port?: number | null; ssh_user?: string | null;
}
type Service = { id: string; name: string; service_type: string; status: Health; status_summary: string | null; observed_at: string | null }
type AssetDetail = Asset & { services: Service[] }
type Summary = { total: number; by_health: Record<Health, number>; by_environment: Record<string, number>; generated_at: string }
type GPUMetric = { name: string; temperature_c: number; utilization_gpu: number; memory_used_mb: number; memory_total_mb: number; power_draw_w: number; fan_speed: number }
type HostMetrics = {
  timestamp: string; hostname: string; uptime_seconds: number;
  cpu_percent: number; cpu_count: number; cpu_freq_mhz: number;
  load_avg_1: number; load_avg_5: number; load_avg_15: number;
  mem_total_mb: number; mem_used_mb: number; mem_available_mb: number; mem_percent: number;
  swap_total_mb: number; swap_used_mb: number; swap_percent: number;
  disk_total_mb: number; disk_used_mb: number; disk_free_mb: number; disk_percent: number;
  gpus: GPUMetric[];
}
type RemoteAsset = { id: string; name: string; ssh_host: string | null; ssh_port: number | null; ssh_user: string | null }
type RemoteExecResult = { stdout: string; stderr: string; exit_code: number; duration: number }
type RemotePingResult = { asset_id: string; name: string; reachable: boolean }

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const HEALTH_LABELS: Record<Health, string> = { healthy: "Healthy", warning: "Warning", critical: "Critical", unknown: "Unknown" }
const NAV_ICONS = { overview: "📊", assets: "🖥", monitoring: "📡", remote: "⌨", settings: "⚙" }

const fmt = (v: string | null) => v ? new Intl.DateTimeFormat("zh-Hant", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(v)) : "—"
const fmtRel = (v: string) => {
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 60000)
  if (d < 1) return "剛剛"
  if (d < 60) return `${d} 分鐘前`
  if (d < 1440) return `${Math.floor(d / 60)} 小時前`
  return `${Math.floor(d / 1440)} 天前`
}

/* ── Small Components ──────────────────────────────────────────────────────── */

function StatusPill({ status }: { status: Health }) {
  return <span className={`status status-${status}`}><i /><span>{HEALTH_LABELS[status]}</span></span>
}

/* ── Dashboard ─────────────────────────────────────────────────────────────── */

export function Dashboard() {
  const { user, logout } = useAuth()

  // State
  const [summary, setSummary] = useState<Summary | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [selected, setSelected] = useState<AssetDetail | null>(null)
  const [query, setQuery] = useState("")
  const [envFilter, setEnvFilter] = useState("")
  const [healthFilter, setHealthFilter] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [hostMetrics, setHostMetrics] = useState<HostMetrics | null>(null)
  const [hostLoading, setHostLoading] = useState(true)
  const [activeSection, setActiveSection] = useState("overview")

  // Remote
  const [remoteAssets, setRemoteAssets] = useState<RemoteAsset[]>([])
  const [remotePing, setRemotePing] = useState<RemotePingResult[]>([])
  const [selectedRemote, setSelectedRemote] = useState("")
  const [remoteCmd, setRemoteCmd] = useState("")
  const [remoteResult, setRemoteResult] = useState<RemoteExecResult | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteHistory, setRemoteHistory] = useState<{ cmd: string; result: RemoteExecResult }[]>([])

  /* ── Data Loaders ──────────────────────────────────────────────────────── */

  const load = async () => {
    setLoading(true); setError(false)
    try {
      const p = new URLSearchParams()
      if (query) p.set("q", query)
      if (envFilter) p.set("environment", envFilter)
      if (healthFilter) p.set("health", healthFilter)
      const [s, r] = await Promise.all([
        api<Summary>("/api/v1/inventory/summary"),
        api<{ items: Asset[] }>(`/api/v1/assets?${p}`),
      ])
      setSummary(s); setAssets(r.items)
    } catch { setError(true) } finally { setLoading(false) }
  }

  const loadHost = async () => {
    setHostLoading(true)
    try { setHostMetrics(await api<HostMetrics>("/api/v1/host/metrics")) }
    catch { /* silent */ } finally { setHostLoading(false) }
  }

  const loadRemoteAssets = async () => {
    try {
      const r = await api<{ items: Asset[] }>(`/api/v1/assets?asset_type=host`)
      setRemoteAssets(r.items.filter(a => a.ssh_host) as RemoteAsset[])
    } catch { /* silent */ }
  }

  const pingAll = async () => {
    try { setRemotePing(await api<RemotePingResult[]>("/api/v1/remote/ping", { method: "POST" })) }
    catch { /* silent */ }
  }

  const executeRemote = async () => {
    if (!selectedRemote || !remoteCmd.trim()) return
    setRemoteLoading(true)
    try {
      const r = await api<RemoteExecResult>("/api/v1/remote/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_id: selectedRemote, command: remoteCmd }),
      })
      setRemoteResult(r)
      setRemoteHistory(prev => [...prev, { cmd: remoteCmd, result: r }])
    } catch (e: any) {
      setRemoteResult({ stdout: "", stderr: String(e), exit_code: -1, duration: 0 })
    } finally { setRemoteLoading(false) }
  }

  const refreshAll = () => { void load(); void loadHost(); void loadRemoteAssets(); void pingAll() }

  useEffect(() => { void load(); void loadHost(); void loadRemoteAssets(); void pingAll() }, [query, envFilter, healthFilter])

  const navigateTo = (section: string) => {
    setActiveSection(section)
    const el = document.getElementById(section)
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const openAsset = async (a: Asset) => {
    try { setSelected(await api<AssetDetail>(`/api/v1/assets/${a.id}`)) }
    catch { setError(true) }
  }

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="shell">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span>OPS CONTROL</span>
        </div>
        <nav>
          {(Object.entries(NAV_ICONS) as [string, string][]).map(([key, icon]) => (
            <a key={key} className={activeSection === key ? "active" : ""} href={`#${key}`}
               onClick={e => { e.preventDefault(); navigateTo(key) }}>
              <span className="nav-icon">{icon}</span>
              <span>{key === "overview" ? "總覽" : key === "assets" ? "資產" : key === "monitoring" ? "監控" : key === "remote" ? "遠程終端" : "設定"}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="user-avatar">{user?.display_name?.[0]?.toUpperCase() ?? "?"}</div>
          <div className="user-info">
            <span className="user-name">{user?.display_name ?? "User"}</span>
            <span className="user-role">{user?.role ?? ""}</span>
          </div>
          <button className="logout-btn" onClick={logout} title="登出">→</button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <div className="content">
        <div className="topbar">
          <div>
            <div className="topbar-title">
              {activeSection === "overview" && "儀表板總覽"}
              {activeSection === "assets" && "資產清單"}
              {activeSection === "monitoring" && "主機監控"}
              {activeSection === "remote" && "遠程終端"}
              {activeSection === "settings" && "系統設定"}
            </div>
            <div className="topbar-breadcrumb">OPS Control System / {activeSection}</div>
          </div>
          <div className="topbar-actions">
            <button className="btn btn-sm" onClick={refreshAll}>↻ 重新整理</button>
          </div>
        </div>

        <div className="page">
          {error && <div className="notice error" style={{ background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>無法載入資料，請確認 API 服務正在運行。</div>}

          {/* ═══ OVERVIEW ═══ */}
          <section id="overview">
            <div className="page-header">
              <div>
                <h1>系統概覽</h1>
                <p>即時掌握基礎設施狀態</p>
              </div>
            </div>

            <div className="stats-row">
              <div className="stat-card">
                <div className="stat-label">總資產數</div>
                <div className="stat-value">{summary?.total ?? 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">健康</div>
                <div className="stat-value" style={{ color: "var(--success)" }}>{summary?.by_health.healthy ?? 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">需關注</div>
                <div className="stat-value" style={{ color: "var(--warning)" }}>{(summary?.by_health.warning ?? 0) + (summary?.by_health.critical ?? 0)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">未知</div>
                <div className="stat-value" style={{ color: "#94a3b8" }}>{summary?.by_health.unknown ?? 0}</div>
              </div>
            </div>

            {/* Environment breakdown */}
            <div className="card" style={{ marginBottom: 24 }}>
              <div className="card-header"><h2>環境分佈</h2></div>
              <div className="card-body">
                {Object.entries(summary?.by_environment ?? {}).map(([name, count]) => (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className={`tag tag-${name}`}>{name}</span>
                    <strong style={{ marginLeft: "auto" }}>{count}</strong>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ═══ ASSETS ═══ */}
          <section id="assets" style={{ marginBottom: 32 }}>
            <div className="page-header">
              <div>
                <h1>資產清單</h1>
                <p>共 {assets.length} 筆 · 更新於 {summary ? fmt(summary.generated_at) : "—"}</p>
              </div>
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
                      <tr key={a.id} onClick={() => void openAsset(a)} style={{ cursor: "pointer" }}>
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
          </section>

          {/* ═══ MONITORING ═══ */}
          <section id="monitoring" style={{ marginBottom: 32 }}>
            <div className="page-header">
              <div>
                <h1>主機監控</h1>
                <p>{hostMetrics?.hostname ?? "—"} · {hostLoading ? "載入中…" : hostMetrics ? "即時數據" : "無法連線"}</p>
              </div>
            </div>

            {hostMetrics && (
              <>
                <div className="host-metrics-row">
                  <div className="host-card">
                    <div className="host-card-label">CPU</div>
                    <div className="host-card-value">{hostMetrics.cpu_percent.toFixed(0)}%</div>
                    <div className="host-bar"><span className={hostMetrics.cpu_percent > 80 ? "high" : hostMetrics.cpu_percent > 50 ? "mid" : ""} style={{ width: `${hostMetrics.cpu_percent}%` }} /></div>
                    <div className="host-card-sub">{hostMetrics.cpu_count} 核心 · {hostMetrics.cpu_freq_mhz.toFixed(0)} MHz · load {hostMetrics.load_avg_1.toFixed(2)}</div>
                  </div>
                  <div className="host-card">
                    <div className="host-card-label">記憶體</div>
                    <div className="host-card-value">{hostMetrics.mem_percent.toFixed(0)}%</div>
                    <div className="host-bar"><span className={hostMetrics.mem_percent > 80 ? "high" : hostMetrics.mem_percent > 50 ? "mid" : ""} style={{ width: `${hostMetrics.mem_percent}%` }} /></div>
                    <div className="host-card-sub">{(hostMetrics.mem_used_mb / 1024).toFixed(1)} / {(hostMetrics.mem_total_mb / 1024).toFixed(1)} GiB</div>
                  </div>
                  <div className="host-card">
                    <div className="host-card-label">磁碟</div>
                    <div className="host-card-value">{hostMetrics.disk_percent.toFixed(0)}%</div>
                    <div className="host-bar"><span className={hostMetrics.disk_percent > 80 ? "high" : hostMetrics.disk_percent > 50 ? "mid" : ""} style={{ width: `${hostMetrics.disk_percent}%` }} /></div>
                    <div className="host-card-sub">{(hostMetrics.disk_used_mb / 1024 / 1024).toFixed(1)} / {(hostMetrics.disk_total_mb / 1024 / 1024).toFixed(1)} TiB</div>
                  </div>
                  <div className="host-card">
                    <div className="host-card-label">運行時間</div>
                    <div className="host-card-value">{hostMetrics.uptime_seconds > 86400 ? (hostMetrics.uptime_seconds / 86400).toFixed(0) + " 天" : (hostMetrics.uptime_seconds / 3600).toFixed(0) + " 小時"}</div>
                    <div className="host-card-sub">swap {(hostMetrics.swap_used_mb / 1024).toFixed(1)} / {(hostMetrics.swap_total_mb / 1024).toFixed(1)} GiB</div>
                  </div>
                </div>

                {hostMetrics.gpus.length > 0 && (
                  <div className="gpu-section">
                    <h3>GPU — {hostMetrics.gpus.length} 裝置</h3>
                    <div className="gpu-grid">
                      {hostMetrics.gpus.map((gpu, i) => (
                        <div className="gpu-card" key={i}>
                          <strong>{gpu.name}</strong>
                          <div className="gpu-row"><span className="gpu-label">溫度</span><span className={`gpu-val ${gpu.temperature_c > 80 ? "hot" : gpu.temperature_c > 70 ? "warm" : ""}`}>{gpu.temperature_c}°C</span></div>
                          <div className="gpu-row"><span className="gpu-label">使用率</span><div className="gpu-bar"><span style={{ width: `${gpu.utilization_gpu}%` }} /></div><span className="gpu-val">{gpu.utilization_gpu}%</span></div>
                          <div className="gpu-row"><span className="gpu-label">VRAM</span><div className="gpu-bar"><span style={{ width: `${gpu.memory_total_mb > 0 ? (gpu.memory_used_mb / gpu.memory_total_mb) * 100 : 0}%` }} /></div><span className="gpu-val">{gpu.memory_used_mb} / {gpu.memory_total_mb} MiB</span></div>
                          <div className="gpu-row"><span className="gpu-label">功耗</span><span className="gpu-val">{gpu.power_draw_w.toFixed(0)} W</span></div>
                          <div className="gpu-row"><span className="gpu-label">風扇</span><span className="gpu-val">{gpu.fan_speed}%</span></div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          {/* ═══ REMOTE ═══ */}
          <section id="remote" style={{ marginBottom: 32 }}>
            <div className="page-header">
              <div>
                <h1>遠程終端</h1>
                <p>SSH 遠程命令執行 · {remoteAssets.length} 台主機</p>
              </div>
              <button className="btn btn-sm" onClick={() => { void pingAll(); void loadRemoteAssets() }}>↻ Ping 全部</button>
            </div>

            {/* Host status */}
            <div className="remote-hosts-row">
              {remotePing.map(p => (
                <div className={`remote-host-chip ${p.reachable ? "online" : "offline"}`} key={p.asset_id}>
                  <span className={`host-dot ${p.reachable ? "online" : "offline"}`} />
                  {p.name}
                </div>
              ))}
            </div>

            {/* Controls */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-body">
                <div className="remote-controls">
                  <select value={selectedRemote} onChange={e => setSelectedRemote(e.target.value)}>
                    <option value="">選擇主機...</option>
                    {remoteAssets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <input className="remote-cmd-input" value={remoteCmd} onChange={e => setRemoteCmd(e.target.value)} placeholder="輸入命令 (例如: uptime, df -h, ls -la)" onKeyDown={e => { if (e.key === "Enter") void executeRemote() }} />
                  <button className="remote-exec-btn" onClick={() => void executeRemote()} disabled={!selectedRemote || !remoteCmd.trim() || remoteLoading}>
                    {remoteLoading ? "⠋ 執行中..." : "▶ 執行"}
                  </button>
                </div>
              </div>
            </div>

            {/* Result */}
            {remoteResult && (
              <div className="remote-output">
                <div className="remote-output-header">
                  <span className={`exit-code ${remoteResult.exit_code === 0 ? "success" : "fail"}`}>Exit: {remoteResult.exit_code}</span>
                  <span className="remote-duration">{remoteResult.duration}s</span>
                </div>
                <pre className="remote-stdout">{remoteResult.stdout || "(no output)"}</pre>
                {remoteResult.stderr && <pre className="remote-stderr">{remoteResult.stderr}</pre>}
              </div>
            )}

            {/* History */}
            {remoteHistory.length > 0 && (
              <div className="remote-history">
                <h3>命令歷史</h3>
                {remoteHistory.map((h, i) => (
                  <div className="history-item" key={i}>
                    <span className="history-cmd">$ {h.cmd}</span>
                    <pre className="history-output">{h.result.stdout || h.result.stderr || "(no output)"}</pre>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ═══ SETTINGS ═══ */}
          <section id="settings">
            <div className="page-header"><div><h1>系統設定</h1><p>版本 0.1.0</p></div></div>
            <div className="card"><div className="card-body" style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              <p>OPS Control System — 基礎設施運維管理控制台</p>
              <p style={{ marginTop: 8 }}>後端: FastAPI + SQLite · 前端: React + Vite</p>
            </div></div>
          </section>
        </div>
      </div>

      {/* ── Asset Detail Drawer ─────────────────────────────────────────── */}
      {selected && (
        <div style={{ position: "fixed", zIndex: 200, top: 0, right: 0, bottom: 0, width: "min(400px, 100vw)", background: "#fff", borderLeft: "1px solid var(--border)", boxShadow: "-4px 0 24px rgba(0,0,0,.12)", overflowY: "auto", padding: "24px" }}>
          <button onClick={() => setSelected(null)} style={{ position: "absolute", right: 16, top: 16, background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "var(--text-secondary)" }}>×</button>
          <h2 style={{ fontSize: 18, marginBottom: 12, marginTop: 16 }}>{selected.name}</h2>
          <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            <span className="tag">{selected.asset_type}</span>
            <span className={`tag tag-${selected.environment}`}>{selected.environment}</span>
            <span className={`tag criticality-${selected.criticality}`}>{selected.criticality}</span>
          </div>
          <StatusPill status={selected.health_status} />
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>{selected.health_summary}</p>
          <dl style={{ display: "grid", gap: 10, marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
              <dt style={{ color: "var(--text-secondary)", fontSize: 12 }}>負責人</dt>
              <dd style={{ fontSize: 12 }}>{selected.owner}</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
              <dt style={{ color: "var(--text-secondary)", fontSize: 12 }}>最後偵測</dt>
              <dd style={{ fontSize: 12 }}>{fmt(selected.last_seen_at)}</dd>
            </div>
          </dl>
          {selected.ssh_host && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>SSH 連線資訊</h3>
              <div style={{ background: "#f8fafc", borderRadius: 6, padding: 12, fontSize: 12, fontFamily: "ui-monospace, monospace", color: "var(--text)" }}>
                <div>ssh {selected.ssh_user}@{selected.ssh_host} -p {selected.ssh_port ?? 22}</div>
              </div>
            </div>
          )}
          <h3 style={{ fontSize: 13, fontWeight: 600, marginTop: 20, marginBottom: 8 }}>關聯服務</h3>
          {selected.services.length ? selected.services.map(s => (
            <div key={s.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 13 }}>{s.name}</strong>
                <StatusPill status={s.status} />
              </div>
              <p style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>{s.status_summary}</p>
            </div>
          )) : <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>無關聯服務</p>}
        </div>
      )}
    </div>
  )
}
