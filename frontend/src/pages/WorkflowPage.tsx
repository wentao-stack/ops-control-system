import { useEffect, useState, useCallback, useRef } from "react"
import { api } from "../auth"
import type {
  WorkflowTemplate,
  WorkflowExecution,
  WorkflowExecutionDetail,
} from "../types"

const STATUS_LABELS: Record<string, string> = {
  pending: "等待中", running: "執行中", completed: "已完成", failed: "失敗",
}
const STATUS_COLORS: Record<string, string> = {
  pending: "#8b97a8", running: "#3b82f6", completed: "#10b981", failed: "#ef4444",
}
const STATUS_BG: Record<string, string> = {
  pending: "#f1f5f9", running: "#dbeafe", completed: "#dcfce7", failed: "#fee2e2",
}

/* ── Execution Detail Drawer ─────────────────────────────────────────── */
function ExecDrawer({ execId, onClose }: { execId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<WorkflowExecutionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api<WorkflowExecutionDetail>(`/api/v1/workflows/executions/${execId}`)
      .then(setDetail).catch(console.error).finally(() => setLoading(false))
  }, [execId])
  if (loading) return null
  if (!detail) return null

  return (
    <div className="wf-drawer-overlay" onClick={onClose}>
      <div className="wf-drawer" onClick={e => e.stopPropagation()}>
        <div className="wf-drawer-header">
          <div>
            <h3>執行 #{detail.id}</h3>
            <p className="wf-drawer-subtitle">{detail.template_name}</p>
          </div>
          <button className="wf-icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="wf-drawer-body">
          <div className="wf-exec-meta-grid">
            <div className="wf-meta-chip">
              <span className="wf-meta-label">狀態</span>
              <span className="wf-chip-status" style={{ background: STATUS_BG[detail.status] || "#f1f5f9", color: STATUS_COLORS[detail.status] }}>
                {STATUS_LABELS[detail.status] || detail.status}
              </span>
            </div>
            <div className="wf-meta-chip">
              <span className="wf-meta-label">使用者</span>
              <span>{detail.user}</span>
            </div>
            <div className="wf-meta-chip">
              <span className="wf-meta-label">開始</span>
              <span>{new Date(detail.started_at).toLocaleString("zh-Hant")}</span>
            </div>
            {detail.completed_at && (
              <div className="wf-meta-chip">
                <span className="wf-meta-label">完成</span>
                <span>{new Date(detail.completed_at).toLocaleString("zh-Hant")}</span>
              </div>
            )}
            <div className="wf-meta-chip">
              <span className="wf-meta-label">耗時</span>
              <span>{detail.duration_seconds.toFixed(1)}s</span>
            </div>
          </div>

          {Object.keys(detail.parameters).length > 0 && (
            <div className="wf-detail-block">
              <h4>輸入參數</h4>
              <pre className="wf-code">{JSON.stringify(detail.parameters, null, 2)}</pre>
            </div>
          )}

          <div className="wf-detail-block">
            <h4>步驟日志</h4>
            <div className="wf-steps-timeline">
              {detail.steps.map((sr, i) => (
                <div key={i} className="wf-timeline-step">
                  <div className="wf-timeline-dot" style={{ background: STATUS_COLORS[sr.status] || "#8b97a8" }}></div>
                  <div className="wf-timeline-content">
                    <div className="wf-timeline-header">
                      <span className="wf-timeline-name">{sr.step}</span>
                      <span className="wf-chip-status" style={{ background: STATUS_BG[sr.status] || "#f1f5f9", color: STATUS_COLORS[sr.status] }}>
                        {STATUS_LABELS[sr.status] || sr.status}
                      </span>
                    </div>
                    {sr.error && <div className="wf-step-err">{sr.error}</div>}
                    {sr.result && Object.keys(sr.result).length > 0 && (
                      <details className="wf-step-detail">
                        <summary>查看結果</summary>
                        <pre className="wf-code">{JSON.stringify(sr.result, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                </div>
              ))}
              {detail.steps.length === 0 && <p className="wf-hint">沒有步驟記錄</p>}
            </div>
          </div>

          {detail.error && (
            <div className="wf-detail-block wf-err-block">
              <h4>錯誤</h4>
              <pre className="wf-code wf-code-err">{detail.error}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Run Form (inline) ──────────────────────────────────────────────── */
function RunForm({ tpl, onRun, onCancel }: { tpl: WorkflowTemplate; onRun: (p: Record<string, any>) => void; onCancel: () => void }) {
  const [fn, setFn] = useState("")
  const [fc, setFc] = useState("")
  const [desc, setDesc] = useState("")
  const [running, setRunning] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const submit = async () => {
    if (!fn || !desc) return alert("請填寫功能名稱和描述")
    setRunning(true)
    try {
      await onRun({ feature_name: fn, files_changed: fc.split(",").map(s => s.trim()).filter(Boolean), description: desc })
    } finally { setRunning(false) }
  }

  return (
    <div className="wf-run-form" ref={ref}>
      <div className="wf-run-form-header">
        <div>
          <h3>🚀 {tpl.name}</h3>
          <p className="wf-run-form-desc">{tpl.description}</p>
        </div>
        <button className="wf-icon-btn" onClick={onCancel}>✕</button>
      </div>
      <div className="wf-run-form-body">
        <div className="wf-field">
          <label>功能名稱 <span className="wf-req">*</span></label>
          <input className="wf-field-input" placeholder="例如: 工作流功能完善" value={fn} onChange={e => setFn(e.target.value)} />
        </div>
        <div className="wf-field">
          <label>修改文件</label>
          <input className="wf-field-input" placeholder="逗號分隔, 如: main.py, WorkflowPage.tsx" value={fc} onChange={e => setFc(e.target.value)} />
        </div>
        <div className="wf-field">
          <label>變更描述 <span className="wf-req">*</span></label>
          <textarea className="wf-field-input" rows={3} placeholder="簡述本次變更的內容..." value={desc} onChange={e => setDesc(e.target.value)} />
        </div>
      </div>
      <div className="wf-run-form-footer">
        <button className="btn" onClick={onCancel}>取消</button>
        <button className="btn btn-primary" onClick={submit} disabled={running}>
          {running ? "⏳ 執行中..." : "▶ 確認執行"}
        </button>
      </div>
    </div>
  )
}

/* ── Execution Timeline Item ────────────────────────────────────────── */
function ExecItem({ exec, tplName, onClick }: { exec: WorkflowExecution; tplName: string; onClick: () => void }) {
  const color = STATUS_COLORS[exec.status] || "#8b97a8"
  const bg = STATUS_BG[exec.status] || "#f1f5f9"
  const label = STATUS_LABELS[exec.status] || exec.status
  const dur = exec.completed_at
    ? (((new Date(exec.completed_at).getTime() - new Date(exec.started_at).getTime()) / 1000).toFixed(1) + "s")
    : "--"

  return (
    <div className="wf-exec-row" onClick={onClick}>
      <div className="wf-exec-row-left">
        <div className="wf-exec-row-icon" style={{ background: bg, color }}>
          {exec.status === "completed" ? "✓" : exec.status === "failed" ? "✕" : "◷"}
        </div>
        <div className="wf-exec-row-info">
          <div className="wf-exec-row-title">{tplName || exec.template_id}</div>
          <div className="wf-exec-row-meta">
            <span>#{exec.id}</span>
            <span>·</span>
            <span>{exec.user}</span>
            <span>·</span>
            <span>{new Date(exec.started_at).toLocaleString("zh-Hant")}</span>
            <span>·</span>
            <span>{dur}</span>
          </div>
        </div>
      </div>
      <span className="wf-chip-status" style={{ background: bg, color }}>{label}</span>
    </div>
  )
}

/* ── Main Page ──────────────────────────────────────────────────────── */
export default function WorkflowPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [executions, setExecutions] = useState<WorkflowExecution[]>([])
  const [showRun, setShowRun] = useState(false)
  const [running, setRunning] = useState(false)
  const [viewExec, setViewExec] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchAll = useCallback(async () => {
    try {
      const [tRes, eRes] = await Promise.all([
        api<{ items: WorkflowTemplate[]; total: number }>("/api/v1/workflows/templates"),
        api<{ items: WorkflowExecution[]; total: number }>("/api/v1/workflows/executions?page_size=20"),
      ])
      setTemplates(tRes.items)
      setExecutions(eRes.items)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleRun = async (params: Record<string, any>) => {
    const tpl = templates[0]
    if (!tpl) return
    setRunning(true)
    try {
      await api("/api/v1/workflows/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: tpl.id, parameters: params }),
      })
      setShowRun(false)
      fetchAll()
    } catch (e) {
      alert("執行失敗: " + (e as Error).message)
    } finally { setRunning(false) }
  }

  const tpl = templates[0]

  return (
    <div className="page wf-page">
      {/* Header */}
      <div className="wf-page-header">
        <div>
          <h1 className="wf-page-title">流程</h1>
          <p className="wf-page-subtitle">自動化流程 · 功能變更記錄</p>
        </div>
        {!loading && tpl && (
          <button className="btn btn-primary wf-launch-btn" onClick={() => setShowRun(true)}>
            ▶ 執行流程
          </button>
        )}
      </div>

      {/* Run Form */}
      {showRun && tpl && (
        <div className="wf-section">
          <RunForm tpl={tpl} onRun={handleRun} onCancel={() => setShowRun(false)} />
        </div>
      )}

      {/* Template Card */}
      {!loading && tpl && (
        <div className="wf-section">
          <div className="wf-tpl-showcase">
            <div className="wf-tpl-showcase-icon">⚡</div>
            <div className="wf-tpl-showcase-info">
              <h3>{tpl.name}</h3>
              <p>{tpl.description}</p>
            </div>
            <div className="wf-tpl-showcase-meta">
              <span className="wf-tpl-tag">參數: {tpl.parameters.length}</span>
              <span className="wf-tpl-tag">步驟: {tpl.steps.length}</span>
            </div>
            <div className="wf-tpl-showcase-steps">
              {tpl.steps.map((s, i) => (
                <div key={i} className="wf-flow-step">
                  <span className="wf-flow-step-num">{i + 1}</span>
                  <span className="wf-flow-step-name">{s.name}</span>
                  <span className="wf-flow-step-type">{s.type}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Execution History */}
      <div className="wf-section">
        <div className="wf-section-header">
          <h2 className="wf-section-title">執行記錄</h2>
          <span className="wf-section-count">{executions.length}</span>
        </div>
        {loading ? (
          <div className="wf-empty-state">載入中...</div>
        ) : executions.length === 0 ? (
          <div className="wf-empty-state">暫無執行記錄</div>
        ) : (
          <div className="wf-exec-timeline">
            {executions.map(ex => (
              <ExecItem
                key={ex.id}
                exec={ex}
                tplName={templates.find(t => t.id === ex.template_id)?.name || ""}
                onClick={() => setViewExec(ex.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Drawer */}
      {viewExec !== null && (
        <ExecDrawer execId={viewExec} onClose={() => setViewExec(null)} />
      )}
    </div>
  )
}
