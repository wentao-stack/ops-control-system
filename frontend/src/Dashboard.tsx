import { useEffect, useMemo, useState } from "react"
import { useAuth } from "./AuthProvider"
import { api } from "./auth"

type Health = "healthy" | "warning" | "critical" | "unknown"
type Asset = { id: string; name: string; asset_type: string; environment: string; owner: string; criticality: string; health_status: Health; health_summary: string | null; last_seen_at: string | null; ssh_host?: string | null; ssh_port?: number | null; ssh_user?: string | null }
type Service = { id: string; name: string; service_type: string; status: Health; status_summary: string | null; observed_at: string | null }
type AssetDetail = Asset & { services: Service[] }
type Summary = { total: number; by_health: Record<Health, number>; by_environment: Record<string, number>; generated_at: string }
type GPUMetric = { name: string; temperature_c: number; utilization_gpu: number; memory_used_mb: number; memory_total_mb: number; power_draw_w: number; fan_speed: number }
type HostMetrics = { timestamp: string; hostname: string; uptime_seconds: number; cpu_percent: number; cpu_count: number; cpu_freq_mhz: number; load_avg_1: number; load_avg_5: number; load_avg_15: number; mem_total_mb: number; mem_used_mb: number; mem_available_mb: number; mem_percent: number; swap_total_mb: number; swap_used_mb: number; swap_percent: number; disk_total_mb: number; disk_used_mb: number; disk_free_mb: number; disk_percent: number; gpus: GPUMetric[] }
type AlertItem = { id: number; title: string; severity: string; source: string; message: string; acknowledged: boolean; acknowledged_by: string | null; created_at: string; acknowledged_at: string | null }
type ChangeItem = { id: number; title: string; change_type: string; status: string; author: string; description: string; affected_assets: string | null; created_at: string; completed_at: string | null }
type RunbookItem = { id: number; title: string; category: string; description: string; steps: string; author: string; created_at: string; updated_at: string }
type RemoteAsset = { id: string; name: string; ssh_host: string | null; ssh_port: number | null; ssh_user: string | null }
type RemoteExecResult = { stdout: string; stderr: string; exit_code: number; duration: number }
type RemotePingResult = { asset_id: string; name: string; reachable: boolean }

const healthLabels: Record<Health, string> = { healthy: "Healthy", warning: "Warning", critical: "Critical", unknown: "Unknown" }
const changeTypeLabels: Record<string, string> = { deploy: "Deploy", config: "Config", incident: "Incident", maintenance: "Maintenance", infra: "Infra" }
const changeStatusLabels: Record<string, string> = { planned: "Planned", in_progress: "In Progress", completed: "Completed", rolled_back: "Rolled Back" }
const formatTime = (value: string | null) => value ? new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value)) : "—"
const formatRelative = (value: string) => {
  const diff = Date.now() - new Date(value).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function StatusPill({ status }: { status: Health }) {
  return <span className={`status status-${status}`}><i />{healthLabels[status]}</span>
}

function MetricCard({ label, count, status }: { label: string; count: number; status: Health | "total" }) {
  return <article className="metric-card"><span className={`metric-icon ${status}`}><i /></span><div><p>{label}</p><strong>{count}</strong></div></article>
}

function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`severity-badge severity-${severity}`}>{severity}</span>
}

function ChangeTypeBadge({ type }: { type: string }) {
  return <span className={`change-badge change-${type}`}>{changeTypeLabels[type] ?? type}</span>
}

function ChangeStatusBadge({ status }: { status: string }) {
  return <span className={`change-status status-${status}`}>{changeStatusLabels[status] ?? status}</span>
}

export function Dashboard() {
  const { user, logout } = useAuth()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [selected, setSelected] = useState<AssetDetail | null>(null)
  const [query, setQuery] = useState("")
  const [environment, setEnvironment] = useState("")
  const [health, setHealth] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [hostMetrics, setHostMetrics] = useState<HostMetrics | null>(null)
  const [hostLoading, setHostLoading] = useState(true)
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [alertSeverity, setAlertSeverity] = useState("")
  const [changes, setChanges] = useState<ChangeItem[]>([])
  const [changeStatus, setChangeStatus] = useState("")
  const [runbooks, setRunbooks] = useState<RunbookItem[]>([])
  const [runbookCategory, setRunbookCategory] = useState("")
  const [selectedRunbook, setSelectedRunbook] = useState<RunbookItem | null>(null)
  const [activeSection, setActiveSection] = useState("overview")

  const loadHost = async () => {
    setHostLoading(true)
    try {
      setHostMetrics(await api<HostMetrics>("/api/v1/host/metrics"))
    } catch { /* silent */ } finally {
      setHostLoading(false)
    }
  }

  const loadAlerts = async () => {
    try {
      const params = new URLSearchParams()
      if (alertSeverity) params.set("severity", alertSeverity)
      const result = await api<{ items: AlertItem[] }>("/api/v1/alerts?" + params)
      setAlerts(result.items)
    } catch { /* silent */ }
  }

  const loadChanges = async () => {
    try {
      const params = new URLSearchParams()
      if (changeStatus) params.set("status", changeStatus)
      const result = await api<{ items: ChangeItem[] }>("/api/v1/changes?" + params)
      setChanges(result.items)
    } catch { /* silent */ }
  }

  const loadRunbooks = async () => {
    try {
      const params = new URLSearchParams()
      if (runbookCategory) params.set("category", runbookCategory)
      const result = await api<{ items: RunbookItem[] }>("/api/v1/runbooks?" + params)
      setRunbooks(result.items)
    } catch { /* silent */ }
  }

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      const params = new URLSearchParams()
      if (query) params.set("q", query)
      if (environment) params.set("environment", environment)
      if (health) params.set("health", health)
      const [nextSummary, result] = await Promise.all([api<Summary>("/api/v1/inventory/summary"), api<{ items: Asset[] }>(`/api/v1/assets?${params}`)])
      setSummary(nextSummary)
      setAssets(result.items)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    void loadHost()
    void loadAlerts()
    void loadChanges()
    void loadRunbooks()
    void loadRemoteAssets()
    void pingAll()
  }, [query, environment, health])

  useEffect(() => { void loadAlerts() }, [alertSeverity])
  useEffect(() => { void loadChanges() }, [changeStatus])
  useEffect(() => { void loadRunbooks() }, [runbookCategory])

  const distribution = useMemo(() => summary ? (Object.entries(summary.by_health) as [Health, number][]).filter(([, count]) => count > 0) : [], [summary])

  const unackedCount = useMemo(() => alerts.filter(a => !a.acknowledged).length, [alerts])
  const activeChanges = useMemo(() => changes.filter(c => c.status === "in_progress").length, [changes])
  const runbookCategories = useMemo(() => [...new Set(runbooks.map(r => r.category))], [runbooks])

  const openAsset = async (asset: Asset) => {
    try {
      setSelected(await api<AssetDetail>(`/api/v1/assets/${asset.id}`))
    } catch { setError(true) }
  }

  // ── Remote Terminal state ──────────────────────────────────────────────────
  const [remoteAssets, setRemoteAssets] = useState<RemoteAsset[]>([])
  const [remotePing, setRemotePing] = useState<RemotePingResult[]>([])
  const [selectedRemote, setSelectedRemote] = useState<string>("")
  const [remoteCmd, setRemoteCmd] = useState("")
  const [remoteResult, setRemoteResult] = useState<RemoteExecResult | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteHistory, setRemoteHistory] = useState<{ cmd: string; result: RemoteExecResult }[]>([])

  const loadRemoteAssets = async () => {
    try {
      const result = await api<{ items: Asset[] }>(`/api/v1/assets?asset_type=host`)
      const withSsh = result.items.filter(a => a.ssh_host) as RemoteAsset[]
      setRemoteAssets(withSsh)
    } catch { /* silent */ }
  }

  const pingAll = async () => {
    try {
      const results = await api<RemotePingResult[]>("/api/v1/remote/ping", { method: "POST" })
      setRemotePing(results)
    } catch { /* silent */ }
  }

  const executeRemote = async () => {
    if (!selectedRemote || !remoteCmd.trim()) return
    setRemoteLoading(true)
    try {
      const result = await api<RemoteExecResult>("/api/v1/remote/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_id: selectedRemote, command: remoteCmd }),
      })
      setRemoteResult(result)
      setRemoteHistory(prev => [...prev, { cmd: remoteCmd, result }])
    } catch (e: any) {
      setRemoteResult({ stdout: "", stderr: String(e), exit_code: -1, duration: 0 })
    } finally {
      setRemoteLoading(false)
    }
  }

  const navigateTo = (section: string) => {
    setActiveSection(section)
    const el = document.getElementById(section)
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <span>OPS<span>CONTROL</span></span>
        </div>
        <nav>
          <a className={activeSection === "overview" ? "active" : ""} href="#overview" onClick={(e) => { e.preventDefault(); navigateTo("overview"); }}>Overview</a>
          <a className={activeSection === "assets" ? "active" : ""} href="#assets" onClick={(e) => { e.preventDefault(); navigateTo("assets"); }}>Assets <b>{summary?.total ?? "–"}</b></a>
          <a className={activeSection === "alerts" ? "active" : ""} href="#alerts" onClick={(e) => { e.preventDefault(); navigateTo("alerts"); }}>Alerts {unackedCount > 0 && <b className="alert-count">{unackedCount}</b>}</a>
          <a className={activeSection === "changes" ? "active" : ""} href="#changes" onClick={(e) => { e.preventDefault(); navigateTo("changes"); }}>Changes {activeChanges > 0 && <b className="alert-count">{activeChanges}</b>}</a>
          <a className={activeSection === "runbooks" ? "active" : ""} href="#runbooks" onClick={(e) => { e.preventDefault(); navigateTo("runbooks"); }}>Runbooks</a>
          <a className={activeSection === "remote" ? "active" : ""} href="#remote" onClick={(e) => { e.preventDefault(); navigateTo("remote"); }}>Remote</a>
        </nav>
        <div className="sidebar-user">
          <div className="user-avatar">{user?.display_name?.[0]?.toUpperCase() ?? "?"}</div>
          <div className="user-info">
            <span className="user-name">{user?.display_name ?? "User"}</span>
            <span className="user-role">{user?.role ?? ""}</span>
          </div>
          <button className="logout-btn" onClick={logout} title="Sign out">→</button>
        </div>
      </aside>
      <section className="content">
        <header>
          <div>
            <p className="eyebrow">INVENTORY / OVERVIEW</p>
            <h1>Infrastructure at a glance.</h1>
            <p className="subhead">A read-only view of your development inventory. No live hosts are contacted.</p>
          </div>
          <button className="refresh" onClick={() => { void load(); void loadHost(); void loadAlerts(); void loadChanges(); void loadRunbooks(); void loadRemoteAssets(); void pingAll(); }} aria-label="Refresh all">↻ <span>Refresh</span></button>
        </header>
        {error && <div className="notice error">Could not load inventory data. Confirm the local API is running, then refresh.</div>}

        {/* ── Overview Metrics ─────────────────────────────────────────────── */}
        <section id="overview" className="metrics">
          <MetricCard label="Total assets" count={summary?.total ?? 0} status="total" />
          <MetricCard label="Healthy" count={summary?.by_health.healthy ?? 0} status="healthy" />
          <MetricCard label="Needs attention" count={(summary?.by_health.warning ?? 0) + (summary?.by_health.critical ?? 0)} status="warning" />
          <MetricCard label="Unknown" count={summary?.by_health.unknown ?? 0} status="unknown" />
        </section>
        <section className="overview-grid">
          <article className="panel health-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">HEALTH DISTRIBUTION</p>
                <h2>Current state</h2>
              </div>
              <span className="live-dot">Fixture data</span>
            </div>
            <div className="distribution">
              {distribution.map(([key, count]) => (
                <div className="distribution-row" key={key}>
                  <div>
                    <StatusPill status={key} />
                    <strong>{count}</strong>
                  </div>
                  <div className="track">
                    <span className={key} style={{ width: `${summary ? (count / summary.total) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </article>
          <article className="panel environment-panel">
            <p className="eyebrow">ENVIRONMENTS</p>
            <h2>Coverage</h2>
            <div className="environment-list">
              {Object.entries(summary?.by_environment ?? {}).map(([name, count]) => (
                <div key={name}>
                  <span className={`env-dot ${name}`} />
                  <p>{name}</p>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
          </article>
        </section>

        {/* ── Host Monitoring ──────────────────────────────────────────────── */}
        <section className="panel host-panel" id="host-monitoring">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">HOST MONITORING</p>
              <h2>{hostMetrics?.hostname ?? "—"}</h2>
            </div>
            <span className="live-dot">{hostLoading ? "Loading…" : hostMetrics ? "Live" : "Unavailable"}</span>
          </div>
          {hostMetrics && (
            <>
              <div className="host-metrics-row">
                <article className="host-card">
                  <p className="host-card-label">CPU</p>
                  <p className="host-card-value">{hostMetrics.cpu_percent.toFixed(0)}%</p>
                  <div className="host-bar"><span className={hostMetrics.cpu_percent > 80 ? "high" : hostMetrics.cpu_percent > 50 ? "mid" : ""} style={{ width: `${hostMetrics.cpu_percent}%` }} /></div>
                  <p className="host-card-sub">{hostMetrics.cpu_count} cores · {hostMetrics.cpu_freq_mhz.toFixed(0)} MHz · load {hostMetrics.load_avg_1.toFixed(2)}</p>
                </article>
                <article className="host-card">
                  <p className="host-card-label">MEMORY</p>
                  <p className="host-card-value">{hostMetrics.mem_percent.toFixed(0)}%</p>
                  <div className="host-bar"><span className={hostMetrics.mem_percent > 80 ? "high" : hostMetrics.mem_percent > 50 ? "mid" : ""} style={{ width: `${hostMetrics.mem_percent}%` }} /></div>
                  <p className="host-card-sub">{(hostMetrics.mem_used_mb / 1024).toFixed(1)} / {(hostMetrics.mem_total_mb / 1024).toFixed(1)} GiB</p>
                </article>
                <article className="host-card">
                  <p className="host-card-label">DISK</p>
                  <p className="host-card-value">{hostMetrics.disk_percent.toFixed(0)}%</p>
                  <div className="host-bar"><span className={hostMetrics.disk_percent > 80 ? "high" : hostMetrics.disk_percent > 50 ? "mid" : ""} style={{ width: `${hostMetrics.disk_percent}%` }} /></div>
                  <p className="host-card-sub">{(hostMetrics.disk_used_mb / 1024 / 1024).toFixed(1)} / {(hostMetrics.disk_total_mb / 1024 / 1024).toFixed(1)} TiB</p>
                </article>
                <article className="host-card">
                  <p className="host-card-label">UPTIME</p>
                  <p className="host-card-value">{hostMetrics.uptime_seconds > 86400 ? (hostMetrics.uptime_seconds / 86400).toFixed(0) + "d" : (hostMetrics.uptime_seconds / 3600).toFixed(0) + "h"}</p>
                  <p className="host-card-sub">swap {(hostMetrics.swap_used_mb / 1024).toFixed(1)} GiB / {(hostMetrics.swap_total_mb / 1024).toFixed(1)} GiB</p>
                </article>
              </div>
              {hostMetrics.gpus.length > 0 && (
                <div className="gpu-section">
                  <h3>GPU — {hostMetrics.gpus.length} device(s)</h3>
                  <div className="gpu-grid">
                    {hostMetrics.gpus.map((gpu, idx) => (
                      <article className="gpu-card" key={idx}>
                        <strong>{gpu.name}</strong>
                        <div className="gpu-row">
                          <span className="gpu-label">Temp</span>
                          <span className={`gpu-val ${gpu.temperature_c > 80 ? "hot" : gpu.temperature_c > 70 ? "warm" : ""}`}>{gpu.temperature_c}°C</span>
                        </div>
                        <div className="gpu-row">
                          <span className="gpu-label">Util</span>
                          <div className="gpu-bar"><span style={{ width: `${gpu.utilization_gpu}%` }} /></div>
                          <span className="gpu-val">{gpu.utilization_gpu}%</span>
                        </div>
                        <div className="gpu-row">
                          <span className="gpu-label">VRAM</span>
                          <div className="gpu-bar"><span style={{ width: `${gpu.memory_total_mb > 0 ? (gpu.memory_used_mb / gpu.memory_total_mb) * 100 : 0}%` }} /></div>
                          <span className="gpu-val">{gpu.memory_used_mb} / {gpu.memory_total_mb} MiB</span>
                        </div>
                        <div className="gpu-row">
                          <span className="gpu-label">Power</span>
                          <span className="gpu-val">{gpu.power_draw_w.toFixed(0)} W</span>
                        </div>
                        <div className="gpu-row">
                          <span className="gpu-label">Fan</span>
                          <span className="gpu-val">{gpu.fan_speed}%</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* ── Alerts ───────────────────────────────────────────────────────── */}
        <section className="panel alerts-panel" id="alerts">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ALERTS</p>
              <h2>Active alerts <span>{alerts.length} total · {unackedCount} unacknowledged</span></h2>
            </div>
            <div className="panel-filters">
              <select value={alertSeverity} onChange={(e) => setAlertSeverity(e.target.value)}>
                <option value="">All severities</option>
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            </div>
          </div>
          <div className="alerts-list">
            {alerts.length === 0 ? (
              <p className="empty-copy">No alerts match the current filter.</p>
            ) : (
              alerts.map((alert) => (
                <article className={`alert-row ${alert.severity} ${alert.acknowledged ? "acknowledged" : ""}`} key={alert.id}>
                  <div className="alert-left">
                    <SeverityBadge severity={alert.severity} />
                    <div className="alert-content">
                      <strong>{alert.title}</strong>
                      <p>{alert.message}</p>
                      <span className="alert-meta">Source: {alert.source} · {formatRelative(alert.created_at)}</span>
                    </div>
                  </div>
                  <div className="alert-right">
                    {alert.acknowledged ? (
                      <span className="ack-badge">✓ Ack by {alert.acknowledged_by ?? "—"}</span>
                    ) : (
                      <span className="unack-badge">⚠ Unacknowledged</span>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        {/* ── Changes ──────────────────────────────────────────────────────── */}
        <section className="panel changes-panel" id="changes">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CHANGE LOG</p>
              <h2>Recent changes <span>{changes.length} total · {activeChanges} in progress</span></h2>
            </div>
            <div className="panel-filters">
              <select value={changeStatus} onChange={(e) => setChangeStatus(e.target.value)}>
                <option value="">All statuses</option>
                <option value="planned">Planned</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="rolled_back">Rolled Back</option>
              </select>
            </div>
          </div>
          <div className="changes-timeline">
            {changes.length === 0 ? (
              <p className="empty-copy">No changes match the current filter.</p>
            ) : (
              changes.map((change) => (
                <article className={`change-row ${change.status}`} key={change.id}>
                  <div className="change-timeline-dot" />
                  <div className="change-content">
                    <div className="change-header">
                      <strong>{change.title}</strong>
                      <div className="change-badges">
                        <ChangeTypeBadge type={change.change_type} />
                        <ChangeStatusBadge status={change.status} />
                      </div>
                    </div>
                    <p>{change.description}</p>
                    <div className="change-meta">
                      <span>By {change.author}</span>
                      <span>{formatRelative(change.created_at)}</span>
                      {change.affected_assets && <span>Affects: {change.affected_assets}</span>}
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        {/* ── Runbooks ─────────────────────────────────────────────────────── */}
        <section className="panel runbooks-panel" id="runbooks">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">RUNBOOKS</p>
              <h2>Procedures & playbooks <span>{runbooks.length} total</span></h2>
            </div>
            <div className="panel-filters">
              <select value={runbookCategory} onChange={(e) => setRunbookCategory(e.target.value)}>
                <option value="">All categories</option>
                {runbookCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>
          </div>
          <div className="runbooks-grid">
            {runbooks.length === 0 ? (
              <p className="empty-copy">No runbooks match the current filter.</p>
            ) : (
              runbooks.map((rb) => (
                <article className={`runbook-card ${selectedRunbook?.id === rb.id ? "expanded" : ""}`} key={rb.id} onClick={() => setSelectedRunbook(selectedRunbook?.id === rb.id ? null : rb)}>
                  <div className="runbook-header">
                    <span className="runbook-category">{rb.category}</span>
                    <strong>{rb.title}</strong>
                  </div>
                  <p className="runbook-desc">{rb.description}</p>
                  <div className="runbook-footer">
                    <span>By {rb.author}</span>
                    <span>Updated {formatTime(rb.updated_at)}</span>
                  </div>
                  {selectedRunbook?.id === rb.id && (
                    <div className="runbook-steps">
                      <h4>Steps</h4>
                      <pre>{rb.steps}</pre>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        </section>

        {/* ── Remote Terminal ──────────────────────────────────────────────── */}
        <section className="panel remote-panel" id="remote">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">REMOTE CONTROL</p>
              <h2>SSH Terminal <span>{remoteAssets.length} hosts</span></h2>
            </div>
            <button className="refresh" onClick={() => { void pingAll(); void loadRemoteAssets(); }}>↻ <span>Ping All</span></button>
          </div>

          {/* Host status row */}
          <div className="remote-hosts-row">
            {remotePing.map(p => (
              <div className={`remote-host-chip ${p.reachable ? "online" : "offline"}`} key={p.asset_id}>
                <span className={`host-dot ${p.reachable ? "online" : "offline"}`} />
                {p.name}
              </div>
            ))}
          </div>

          {/* Terminal controls */}
          <div className="remote-controls">
            <select value={selectedRemote} onChange={e => setSelectedRemote(e.target.value)}>
              <option value="">Select host...</option>
              {remoteAssets.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <input
              className="remote-cmd-input"
              value={remoteCmd}
              onChange={e => setRemoteCmd(e.target.value)}
              placeholder="Enter command (e.g. uptime, df -h, ls -la)"
              onKeyDown={e => { if (e.key === "Enter") void executeRemote() }}
            />
            <button className="remote-exec-btn" onClick={() => void executeRemote()} disabled={!selectedRemote || !remoteCmd.trim() || remoteLoading}>
              {remoteLoading ? "⠋ Running..." : "▶ Execute"}
            </button>
          </div>

          {/* Current result */}
          {remoteResult && (
            <div className="remote-output">
              <div className="remote-output-header">
                <span className={`exit-code ${remoteResult.exit_code === 0 ? "success" : "fail"}`}>
                  Exit: {remoteResult.exit_code}
                </span>
                <span className="remote-duration">{remoteResult.duration}s</span>
              </div>
              <pre className="remote-stdout">{remoteResult.stdout || "(no output)"}</pre>
              {remoteResult.stderr && <pre className="remote-stderr">{remoteResult.stderr}</pre>}
            </div>
          )}

          {/* History */}
          {remoteHistory.length > 0 && (
            <div className="remote-history">
              <h3>Command History</h3>
              {remoteHistory.map((h, i) => (
                <div className="history-item" key={i}>
                  <span className="history-cmd">$ {h.cmd}</span>
                  <pre className="history-output">{h.result.stdout || h.result.stderr || "(no output)"}</pre>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Assets ───────────────────────────────────────────────────────── */}
        <section id="assets" className="panel assets-panel">
          <div className="panel-heading asset-title">
            <div>
              <p className="eyebrow">ASSET DIRECTORY</p>
              <h2>Inventory assets <span>{assets.length} shown</span></h2>
            </div>
            <div className="updated">Updated {summary ? formatTime(summary.generated_at) : "…"}</div>
          </div>
          <div className="filters">
            <label className="search">
              <span>⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name" />
            </label>
            <select value={environment} onChange={(event) => setEnvironment(event.target.value)}>
              <option value="">All environments</option>
              <option value="development">Development</option>
              <option value="staging">Staging</option>
              <option value="production">Production</option>
            </select>
            <select value={health} onChange={(event) => setHealth(event.target.value)}>
              <option value="">All health states</option>
              {Object.entries(healthLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            {(query || environment || health) && (
              <button className="clear" onClick={() => { setQuery(""); setEnvironment(""); setHealth("") }}>Clear filters</button>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Environment</th>
                  <th>Owner</th>
                  <th>Criticality</th>
                  <th>Health</th>
                  <th>Last observed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="empty">Loading inventory…</td></tr>
                ) : assets.length === 0 ? (
                  <tr><td colSpan={7} className="empty">No assets match the current filters.</td></tr>
                ) : (
                  assets.map((asset) => (
                    <tr key={asset.id} onClick={() => void openAsset(asset)}>
                      <td><strong>{asset.name}</strong><small>{asset.asset_type}</small></td>
                      <td><span className="environment-tag">{asset.environment}</span></td>
                      <td>{asset.owner}</td>
                      <td><span className={`criticality ${asset.criticality}`}>{asset.criticality}</span></td>
                      <td><StatusPill status={asset.health_status} /></td>
                      <td>{formatTime(asset.last_seen_at)}</td>
                      <td className="chevron">›</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
      {selected && (
        <aside className="drawer">
          <button className="close" onClick={() => setSelected(null)}>×</button>
          <p className="eyebrow">ASSET DETAIL</p>
          <h2>{selected.name}</h2>
          <div className="drawer-meta">
            <span>{selected.asset_type}</span>
            <span>{selected.environment}</span>
            <span>{selected.criticality} criticality</span>
          </div>
          <StatusPill status={selected.health_status} />
          <p className="summary-copy">{selected.health_summary}</p>
          <dl>
            <div><dt>Owner</dt><dd>{selected.owner}</dd></div>
            <div><dt>Last observed</dt><dd>{formatTime(selected.last_seen_at)}</dd></div>
          </dl>
          <h3>Associated services</h3>
          {selected.services.length ? (
            selected.services.map((service) => (
              <article className="service" key={service.id}>
                <div><strong>{service.name}</strong><small>{service.service_type}</small></div>
                <StatusPill status={service.status} />
                <p>{service.status_summary}</p>
              </article>
            ))
          ) : (
            <p className="empty-copy">No services recorded for this asset.</p>
          )}
          <p className="privacy-note">This view deliberately excludes network addresses, credentials, ports, and raw logs.</p>
        </aside>
      )}
    </main>
  )
}
