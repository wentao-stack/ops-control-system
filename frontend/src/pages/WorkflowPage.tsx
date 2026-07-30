import { useEffect, useState, useCallback } from "react"
import { api } from "../auth"
import type {
  WorkflowTemplate,
  WorkflowExecution,
  WorkflowExecutionDetail,
  WorkflowParameter,
  WorkflowStep,
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

/* ── Run Modal ──────────────────────────────────────────────────────── */
function RunModal({ tpl, onRun, onClose }: { tpl: WorkflowTemplate; onRun: (p: Record<string, any>) => void; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)

  const submit = async () => {
    const parsed: Record<string, any> = {}
    for (const p of tpl.parameters) {
      const raw = values[p.name] || ""
      if (p.type === "list") parsed[p.name] = raw.split(",").map(s => s.trim()).filter(Boolean)
      else if (p.type === "int" || p.type === "number") parsed[p.name] = parseInt(raw, 10) || 0
      else parsed[p.name] = raw
    }
    setRunning(true)
    try { await onRun(parsed) } finally { setRunning(false) }
  }

  return (
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-modal-header">
          <h3>▶ 執行: {tpl.name}</h3>
          <button className="wf-icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="wf-modal-body">
          {tpl.parameters.length > 0 ? tpl.parameters.map(p => (
            <div className="wf-field" key={p.name}>
              <label>{p.name} {p.required && <span className="wf-req">*</span>}</label>
              {p.type === "list" ? (
                <textarea className="wf-field-input" rows={2} placeholder={p.description || "逗號分隔"} value={values[p.name] || ""} onChange={e => setValues({ ...values, [p.name]: e.target.value })} />
              ) : (
                <input className="wf-field-input" placeholder={p.description || p.name} value={values[p.name] || ""} onChange={e => setValues({ ...values, [p.name]: e.target.value })} />
              )}
            </div>
          )) : <p className="wf-hint">此流程不需要參數</p>}
        </div>
        <div className="wf-modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={running}>
            {running ? "⏳ 執行中..." : "▶ 確認執行"}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Edit Modal ─────────────────────────────────────────────────────── */
function EditModal({ tpl, onSave, onClose }: { tpl: WorkflowTemplate; onSave: (data: any) => void; onClose: () => void }) {
  const [name, setName] = useState(tpl.name)
  const [desc, setDesc] = useState(tpl.description)
  const [params, setParams] = useState<WorkflowParameter[]>([...tpl.parameters])
  const [steps, setSteps] = useState<WorkflowStep[]>([...tpl.steps])

  const addParam = () => setParams([...params, { name: "", type: "str", description: "", required: false, default: null }])
  const removeParam = (i: number) => setParams(params.filter((_, j) => j !== i))
  const updateParam = (i: number, p: WorkflowParameter) => { const n = [...params]; n[i] = p; setParams(n) }

  const addStep = () => setSteps([...steps, { type: "llm", name: "", config: {} }])
  const removeStep = (i: number) => setSteps(steps.filter((_, j) => j !== i))
  const updateStep = (i: number, s: WorkflowStep) => { const n = [...steps]; n[i] = s; setSteps(n) }

  const save = () => {
    if (!name) return alert("請填寫名稱")
    onSave({ name, description: desc, parameters: params, steps })
  }

  return (
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal-lg" onClick={e => e.stopPropagation()}>
        <div className="wf-modal-header">
          <h3>✏️ 編輯: {tpl.name}</h3>
          <button className="wf-icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="wf-modal-body wf-scroll-body">
          <div className="wf-field">
            <label>名稱</label>
            <input className="wf-field-input" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="wf-field">
            <label>描述</label>
            <textarea className="wf-field-input" rows={2} value={desc} onChange={e => setDesc(e.target.value)} />
          </div>

          <div className="wf-edit-section">
            <div className="wf-edit-section-header">
              <h4>參數 ({params.length})</h4>
              <button className="btn btn-sm" onClick={addParam}>+ 新增</button>
            </div>
            {params.map((p, i) => (
              <div className="wf-edit-row" key={i}>
                <input className="wf-field-input wf-field-sm" placeholder="名稱" value={p.name} onChange={e => updateParam(i, { ...p, name: e.target.value })} />
                <select className="wf-field-input wf-field-sm" value={p.type} onChange={e => updateParam(i, { ...p, type: e.target.value })}>
                  <option value="str">str</option><option value="int">int</option><option value="number">number</option><option value="bool">bool</option><option value="list">list</option>
                </select>
                <input className="wf-field-input wf-field-sm" placeholder="描述" value={p.description} onChange={e => updateParam(i, { ...p, description: e.target.value })} />
                <label className="wf-check-label"><input type="checkbox" checked={p.required} onChange={e => updateParam(i, { ...p, required: e.target.checked })} />必填</label>
                <button className="wf-icon-btn" onClick={() => removeParam(i)}>✕</button>
              </div>
            ))}
          </div>

          <div className="wf-edit-section">
            <div className="wf-edit-section-header">
              <h4>步驟 ({steps.length})</h4>
              <button className="btn btn-sm" onClick={addStep}>+ 新增</button>
            </div>
            {steps.map((s, i) => (
              <div className="wf-edit-step" key={i}>
                <div className="wf-edit-step-header">
                  <span className="wf-step-num">#{i + 1}</span>
                  <select className="wf-field-input wf-field-sm" value={s.type} onChange={e => updateStep(i, { ...s, type: e.target.value })}>
                    <option value="llm">🤖 LLM 生成</option>
                    <option value="api">🌐 API 呼叫</option>
                    <option value="note_create">📝 建立筆記</option>
                  </select>
                  <input className="wf-field-input wf-field-sm" placeholder="步驟名稱" value={s.name} onChange={e => updateStep(i, { ...s, name: e.target.value })} />
                  <button className="wf-icon-btn" onClick={() => removeStep(i)}>✕</button>
                </div>
                <textarea className="wf-field-input wf-code" rows={3} placeholder="config JSON" value={JSON.stringify(s.config, null, 2)} onChange={e => { try { updateStep(i, { ...s, config: JSON.parse(e.target.value) }) } catch {} }} />
              </div>
            ))}
          </div>
        </div>
        <div className="wf-modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={save}>💾 儲存</button>
        </div>
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
            <span>#{exec.id}</span><span>·</span><span>{exec.user}</span><span>·</span>
            <span>{new Date(exec.started_at).toLocaleString("zh-Hant")}</span><span>·</span><span>{dur}</span>
          </div>
        </div>
      </div>
      <span className="wf-chip-status" style={{ background: bg, color }}>{label}</span>
    </div>
  )
}

/* ── Template Card ──────────────────────────────────────────────────── */
function TplCard({ tpl, onRun, onEdit }: { tpl: WorkflowTemplate; onRun: (t: WorkflowTemplate) => void; onEdit: (t: WorkflowTemplate) => void }) {
  return (
    <div className="wf-tpl-card">
      <div className="wf-tpl-card-top">
        <div className="wf-tpl-card-icon">⚡</div>
        <div className="wf-tpl-card-info">
          <h3>{tpl.name}</h3>
          <p>{tpl.description}</p>
        </div>
      </div>
      <div className="wf-tpl-card-steps">
        {tpl.steps.map((s, i) => (
          <div key={i} className="wf-flow-step">
            <span className="wf-flow-step-num">{i + 1}</span>
            <span className="wf-flow-step-name">{s.name}</span>
            <span className="wf-flow-step-type">{s.type}</span>
          </div>
        ))}
      </div>
      <div className="wf-tpl-card-actions">
        <button className="btn btn-primary wf-run-card-btn" onClick={() => onRun(tpl)}>▶ 執行</button>
        <button className="btn" onClick={() => onEdit(tpl)}>✏️ 編輯</button>
      </div>
    </div>
  )
}

/* ── Main Page ──────────────────────────────────────────────────────── */
export default function WorkflowPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [executions, setExecutions] = useState<WorkflowExecution[]>([])
  const [runTpl, setRunTpl] = useState<WorkflowTemplate | null>(null)
  const [editTpl, setEditTpl] = useState<WorkflowTemplate | null>(null)
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
    if (!runTpl) return
    try {
      await api("/api/v1/workflows/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: runTpl.id, parameters: params }),
      })
      setRunTpl(null)
      fetchAll()
    } catch (e) { alert("執行失敗: " + (e as Error).message) }
  }

  const handleEdit = async (data: any) => {
    if (!editTpl) return
    try {
      await api(`/api/v1/workflows/templates/${editTpl.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })
      setEditTpl(null)
      fetchAll()
    } catch (e) { alert("儲存失敗: " + (e as Error).message) }
  }

  return (
    <div className="page wf-page">
      <div className="wf-page-header">
        <div>
          <h1 className="wf-page-title">流程</h1>
          <p className="wf-page-subtitle">自動化流程管理</p>
        </div>
      </div>

      {/* Template Cards */}
      <div className="wf-section">
        <div className="wf-section-header">
          <h2 className="wf-section-title">流程模板</h2>
          <span className="wf-section-count">{templates.length}</span>
        </div>
        {loading ? (
          <div className="wf-empty-state">載入中...</div>
        ) : templates.length === 0 ? (
          <div className="wf-empty-state">暫無流程模板</div>
        ) : (
          <div className="wf-tpl-grid">
            {templates.map(t => (
              <TplCard key={t.id} tpl={t} onRun={setRunTpl} onEdit={setEditTpl} />
            ))}
          </div>
        )}
      </div>

      {/* Execution History */}
      <div className="wf-section">
        <div className="wf-section-header">
          <h2 className="wf-section-title">執行記錄</h2>
          <span className="wf-section-count">{executions.length}</span>
        </div>
        {executions.length === 0 ? (
          <div className="wf-empty-state">暫無執行記錄</div>
        ) : (
          <div className="wf-exec-timeline">
            {executions.map(ex => (
              <ExecItem key={ex.id} exec={ex} tplName={templates.find(t => t.id === ex.template_id)?.name || ""} onClick={() => setViewExec(ex.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {runTpl && <RunModal tpl={runTpl} onRun={handleRun} onClose={() => setRunTpl(null)} />}
      {editTpl && <EditModal tpl={editTpl} onSave={handleEdit} onClose={() => setEditTpl(null)} />}
      {viewExec !== null && <ExecDrawer execId={viewExec} onClose={() => setViewExec(null)} />}
    </div>
  )
}
