import { useEffect, useState, useRef, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { api } from "../auth"
import { GPUMetric, SupervisorProcess, SupervisorHostStatus, SupervisorAllStatus, SupervisorLogSource } from "../types"

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

const STATUS_COLORS: Record<string, string> = {
  RUNNING: "#16a34a",
  STOPPED: "#dc2626",
  STARTING: "#2563eb",
  STOPPING: "#d97706",
  FATAL: "#dc2626",
  BACKOFF: "#d97706",
}

const STATUS_LABELS: Record<string, string> = {
  RUNNING: "運行中",
  STOPPED: "已停止",
  STARTING: "啟動中",
  STOPPING: "停止中",
  FATAL: "致命錯誤",
  BACKOFF: "重試中",
}

// ── Service detection badge (original) ──────────────────────────────────────

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

// ── Supervisor process row with action buttons ──────────────────────────────

function SupervisorProcessRow({
  proc,
  assetId,
  onAction,
  actionLoading,
}: {
  proc: SupervisorProcess
  assetId: string
  onAction: (assetId: string, action: string, process: string) => Promise<void>
  actionLoading: string | null
}) {
  const [showLogs, setShowLogs] = useState(false)
  const [logSources, setLogSources] = useState<SupervisorLogSource[]>([])
  const [activeSourceIdx, setActiveSourceIdx] = useState(0)
  const [loadingLogs, setLoadingLogs] = useState(false)

  const statusColor = STATUS_COLORS[proc.status] ?? "#6b7280"
  const statusLabel = STATUS_LABELS[proc.status] ?? proc.status

  const isLoading = actionLoading === proc.display_name

  const loadLogs = async () => {
    if (loadingLogs) return
    setLoadingLogs(true)
    try {
      const result = await api<{
        process: string; lines: string[]; truncated: boolean; sources: SupervisorLogSource[]
      }>(
        "/api/v1/supervisor/tail",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asset_id: assetId, process: proc.display_name, lines: 50 }),
        },
      )
      setLogSources(result.sources)
      setActiveSourceIdx(0)
      setShowLogs(true)
    } catch { /* silent */ } finally {
      setLoadingLogs(false)
    }
  }

  const activeSource = logSources[activeSourceIdx]

  return (
    <div>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        borderBottom: "1px solid #f1f5f9",
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: statusColor,
          boxShadow: proc.status === "RUNNING" ? `0 0 6px ${statusColor}60` : "none",
          flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, fontSize: 13, minWidth: 120 }}>{proc.display_name}</span>
        <span style={{
          fontSize: 10,
          padding: "2px 8px",
          borderRadius: 4,
          background: statusColor + "18",
          color: statusColor,
          fontWeight: 600,
        }}>
          {statusLabel}
        </span>
        {proc.pid > 0 && (
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>PID: {proc.pid}</span>
        )}
        {proc.uptime && (
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{proc.uptime}</span>
        )}
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4 }}>
          {proc.status === "RUNNING" && (
            <>
              <button
                className="btn btn-sm"
                style={{ fontSize: 11, padding: "2px 8px", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}
                onClick={() => void onAction(assetId, "restart", proc.display_name)}
                disabled={isLoading}
                title="重啟"
              >
                ↻
              </button>
              <button
                className="btn btn-sm"
                style={{ fontSize: 11, padding: "2px 8px", background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" }}
                onClick={() => void onAction(assetId, "stop", proc.display_name)}
                disabled={isLoading}
                title="停止"
              >
                ■
              </button>
            </>
          )}
          {proc.status === "STOPPED" && (
            <button
              className="btn btn-sm"
              style={{ fontSize: 11, padding: "2px 8px", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}
              onClick={() => void onAction(assetId, "start", proc.display_name)}
              disabled={isLoading}
              title="啟動"
            >
              ▶
            </button>
          )}
          <button
            className="btn btn-sm"
            style={{ fontSize: 11, padding: "2px 8px", background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" }}
            onClick={() => void loadLogs()}
            disabled={loadingLogs}
            title="查看日誌"
          >
            {loadingLogs ? "⠋" : "📋"}
          </button>
        </div>
      </div>

      {/* Log output panel with source tabs */}
      {showLogs && (
        <div style={{
          margin: "4px 12px 8px 32px",
          background: "#1e293b",
          color: "#e2e8f0",
          borderRadius: 6,
          overflow: "hidden",
        }}>
          {/* Source selector tabs */}
          {logSources.length > 1 && (
            <div style={{
              display: "flex",
              borderBottom: "1px solid #334155",
              overflowX: "auto",
            }}>
              {logSources.map((src, idx) => (
                <button
                  key={idx}
                  onClick={() => setActiveSourceIdx(idx)}
                  style={{
                    padding: "4px 12px",
                    background: idx === activeSourceIdx ? "#334155" : "transparent",
                    border: "none",
                    color: idx === activeSourceIdx ? "#e2e8f0" : "#94a3b8",
                    cursor: "pointer",
                    fontSize: 10,
                    fontWeight: idx === activeSourceIdx ? 600 : 400,
                    borderBottom: idx === activeSourceIdx ? "2px solid #6366f1" : "2px solid transparent",
                    whiteSpace: "nowrap",
                  }}
                >
                  {src.label} ({src.lines.length})
                </button>
              ))}
            </div>
          )}
          {/* Log content */}
          <div style={{
            padding: "8px 12px",
            fontSize: 11,
            fontFamily: "monospace",
            maxHeight: 250,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}>
            {activeSource
              ? (activeSource.lines.length === 0 ? "(no log output)" : activeSource.lines.join("\n"))
              : "(no log sources available)"}
          </div>
          <div style={{ padding: "4px 12px 8px", display: "flex", justifyContent: "flex-end" }}>
            <button
              style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 10 }}
              onClick={() => { setShowLogs(false); setLogSources([]) }}
            >
              ✕ 關閉
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page with tabs ─────────────────────────────────────────────────────

export function ServicesPage() {

    const { t } = useTranslation()
const [tab, setTab] = useState<"detect" | "supervisor">("supervisor")

  // ── Service detection state (original) ──
  const [detectData, setDetectData] = useState<HostServices[]>([])
  const [detectLoading, setDetectLoading] = useState(true)
  const [detectCollecting, setDetectCollecting] = useState(false)
  const [detectCollectedAt, setDetectCollectedAt] = useState("")

  // ── Supervisor state ──
  const [supData, setSupData] = useState<SupervisorHostStatus[]>([])
  const [supLoading, setSupLoading] = useState(true)
  const [supCollecting, setSupCollecting] = useState(false)
  const [supCollectedAt, setSupCollectedAt] = useState("")
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionFeedback, setActionFeedback] = useState<{ msg: string; ok: boolean } | null>(null)

  // ── Load service detection ──
  const loadDetect = useCallback(async (useCache = false) => {
    const url = useCache ? "/api/v1/hosts/services?cache=true" : "/api/v1/hosts/services"
    if (!useCache) setDetectCollecting(true)
    try {
      const all = await api<AllServices>(url)
      setDetectData(all.hosts)
      setDetectCollectedAt(new Intl.DateTimeFormat("zh-Hant", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).format(new Date(all.collected_at)))
    } catch { /* silent */ } finally {
      if (!useCache) setDetectCollecting(false)
      setDetectLoading(false)
    }
  }, [])

  // ── Load supervisor status ──
  const loadSupervisor = useCallback(async (useCache = false) => {
    const url = useCache ? "/api/v1/supervisor/status?cache=true" : "/api/v1/supervisor/status"
    if (!useCache) setSupCollecting(true)
    try {
      const all = await api<SupervisorAllStatus>(url)
      setSupData(all.hosts)
      setSupCollectedAt(new Intl.DateTimeFormat("zh-Hant", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).format(new Date(all.collected_at)))
    } catch { /* silent */ } finally {
      if (!useCache) setSupCollecting(false)
      setSupLoading(false)
    }
  }, [])

  // Preload both tabs with cached data on mount
  useEffect(() => {
    void loadDetect(true)
    void loadSupervisor(true)
    // Then load fresh data for active tab
    if (tab === "supervisor") {
      void loadSupervisor(false)
    } else {
      void loadDetect(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload active tab when switching
  useEffect(() => {
    if (tab === "supervisor" && supData.length === 0) {
      void loadSupervisor(false)
    } else if (tab === "detect" && detectData.length === 0) {
      void loadDetect(false)
    }
  }, [tab, loadDetect, loadSupervisor, supData.length, detectData.length])

  // ── Supervisor action handler ──
  const handleSupervisorAction = useCallback(async (assetId: string, action: string, process: string) => {
    setActionLoading(process)
    setActionFeedback(null)
    try {
      const result = await api<{ success: boolean; process: string; message: string }>(
        "/api/v1/supervisor/action",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asset_id: assetId, action, process }),
        },
      )
      setActionFeedback({
        msg: result.success
          ? `${process} → ${action} ✓`
          : `${process} → ${action} ✗ ${result.message}`,
        ok: result.success,
      })
      // Reload after action
      setTimeout(() => { void loadSupervisor(false) }, 1500)
    } catch (e: any) {
      setActionFeedback({ msg: `${process} → ${action} 失敗: ${e.message}`, ok: false })
    } finally {
      setActionLoading(null)
    }
  }, [loadSupervisor])

  // ── Tab content ──
  const totalDetectServices = detectData.reduce((sum, h) => sum + h.services.length, 0)
  const totalSupProcesses = supData.reduce((sum, h) => sum + h.processes.length, 0)
  const supRunning = supData.reduce(
    (sum, h) => sum + h.processes.filter(p => p.status === "RUNNING").length, 0,
  )
  const supStopped = totalSupProcesses - supRunning

  return (
    <>
      <div className="page-header">
        <div>
          <h1>服務總覽</h1>
          <p>遠程主機{t("services.detect")}與 Supervisor {t("services.supervisor")}</p>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{
        display: "flex", gap: 0, marginBottom: 20,
        borderBottom: "2px solid var(--border)",
      }}>
        <button
          onClick={() => setTab("supervisor")}
          style={{
            padding: "10px 20px",
            background: "none", border: "none",
            borderBottom: tab === "supervisor" ? "2px solid #6366f1" : "2px solid transparent",
            marginBottom: -2,
            fontWeight: tab === "supervisor" ? 600 : 400,
            color: tab === "supervisor" ? "#6366f1" : "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          Supervisor {t("services.supervisor")}
        </button>
        <button
          onClick={() => setTab("detect")}
          style={{
            padding: "10px 20px",
            background: "none", border: "none",
            borderBottom: tab === "detect" ? "2px solid #6366f1" : "2px solid transparent",
            marginBottom: -2,
            fontWeight: tab === "detect" ? 600 : 400,
            color: tab === "detect" ? "#6366f1" : "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          {t("services.detect")}
        </button>
      </div>

      {/* Action feedback toast */}
      {actionFeedback && (
        <div style={{
          padding: "8px 16px",
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 13,
          background: actionFeedback.ok ? "#dcfce7" : "#fef2f2",
          color: actionFeedback.ok ? "#166534" : "#991b1b",
          border: `1px solid ${actionFeedback.ok ? "#bbf7d0" : "#fecaca"}`,
        }}>
          {actionFeedback.msg}
        </div>
      )}

      {/* ── Supervisor tab ── */}
      {tab === "supervisor" && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={() => { void loadSupervisor(false) }} disabled={supCollecting}>
              {supCollecting ? "⠋ 載入中..." : "重新載入"}
            </button>
          </div>

          {/* Summary row */}
          {!supLoading && supData.length > 0 && (
            <div style={{
              display: "flex", gap: 16, marginBottom: 16,
            }}>
              <div className="stat-card" style={{ flex: 1, minWidth: 0 }}>
                <div className="stat-value">{supData.length}</div>
                <div className="stat-label">受管主機</div>
              </div>
              <div className="stat-card" style={{ flex: 1, minWidth: 0 }}>
                <div className="stat-value" style={{ color: "#16a34a" }}>{supRunning}</div>
                <div className="stat-label">運行中</div>
              </div>
              <div className="stat-card" style={{ flex: 1, minWidth: 0 }}>
                <div className="stat-value" style={{ color: "#dc2626" }}>{supStopped}</div>
                <div className="stat-label">已停止</div>
              </div>
              <div className="stat-card" style={{ flex: 1, minWidth: 0 }}>
                <div className="stat-value" style={{ fontSize: 16 }}>{supCollectedAt}</div>
                <div className="stat-label">最後更新</div>
              </div>
            </div>
          )}

          {supLoading && <div className="empty">載入中…</div>}

          {supData.length === 0 && !supLoading && (
            <div className="card"><div className="card-body"><p style={{ color: "var(--text-secondary)", fontSize: 13 }}>沒有可管理的遠程主機</p></div></div>
          )}

          <div style={{ display: "grid", gap: 16 }}>
            {supData.map(host => (
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
                        {host.hostname} · {host.processes.length} 個進程
                        {host.error && ` · 錯誤: ${host.error}`}
                      </span>
                    </div>
                  </div>
                  <Link to={`/assets/${host.asset_id}`} className="btn btn-sm">詳情</Link>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {host.processes.length === 0 ? (
                    <p style={{ color: "var(--text-secondary)", fontSize: 13, padding: 12 }}>
                      {host.reachable ? "該主機沒有 Supervisor 管理的進程" : "無法連接"}
                    </p>
                  ) : (
                    host.processes.map((proc, i) => (
                      <SupervisorProcessRow
                        key={i}
                        proc={proc}
                        assetId={host.asset_id}
                        onAction={handleSupervisorAction}
                        actionLoading={actionLoading}
                      />
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Service detection tab (original) ── */}
      {tab === "detect" && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={() => { void loadDetect(false) }} disabled={detectCollecting}>
              {detectCollecting ? "⠋ 偵測中..." : "↻ 重新偵測"}
            </button>
          </div>

          {detectLoading && <div className="empty">載入中…</div>}

          {detectData.length === 0 && !detectLoading && (
            <div className="card"><div className="card-body"><p style={{ color: "var(--text-secondary)", fontSize: 13 }}>{t("services.noHosts")}</p></div></div>
          )}

          <div style={{ display: "grid", gap: 16 }}>
            {detectData.map(host => (
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
      )}
    </>
  )
}