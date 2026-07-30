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

/* ── Note API definitions ──────────────────────────────────────────── */
const NOTE_APIS = [
  { method: "POST", path: "/api/v1/notes", label: "建立筆記", fields: [
    { key: "title", label: "標題", required: true, type: "str" },
    { key: "category", label: "分類", required: true, type: "str" },
    { key: "content", label: "內容", required: false, type: "text" },
    { key: "tags", label: "標籤", required: false, type: "str" },
  ]},
  { method: "GET", path: "/api/v1/notes", label: "列出筆記", fields: [
    { key: "page", label: "頁碼", required: false, type: "int" },
    { key: "page_size", label: "每頁數量", required: false, type: "int" },
    { key: "category", label: "分類篩選", required: false, type: "str" },
  ]},
  { method: "GET", path: "/api/v1/notes/{id}", label: "查看筆記", fields: [
    { key: "id", label: "筆記 ID", required: true, type: "str" },
  ]},
  { method: "PUT", path: "/api/v1/notes/{id}", label: "更新筆記", fields: [
    { key: "id", label: "筆記 ID", required: true, type: "str" },
    { key: "title", label: "標題", required: false, type: "str" },
    { key: "category", label: "分類", required: false, type: "str" },
    { key: "content", label: "內容", required: false, type: "text" },
    { key: "tags", label: "標籤", required: false, type: "str" },
  ]},
  { method: "DELETE", path: "/api/v1/notes/{id}", label: "刪除筆記", fields: [
    { key: "id", label: "筆記 ID", required: true, type: "str" },
  ]},
]

/* ── Execution Detail Drawer ─────────────────────────────────────────── */
function ExecDrawer({ execId, onClose }: { execId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<WorkflowExecutionDetail | null>(null)
  const [showCreate, setShowCreate] = useState(false)
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

/* ── Extract dynamic params from step configs ───────────────────────── */
function extractDynParams(steps: WorkflowStep[]) {
  const seen = new Set<string>()
  const params: Array<{ key: string; label: string; required: boolean; type: string; default: string }> = []
  for (const step of steps) {
    const cfg = step.config as any
    if (step.type === "note_api" && cfg.fields) {
      const apiDef = NOTE_APIS.find(a => a.path === (cfg.path || ""))
      if (apiDef) {
        for (const f of apiDef.fields) {
          if (!seen.has(f.key)) {
            seen.add(f.key)
            params.push({ key: f.key, label: f.label, required: f.required, type: f.type, default: cfg.fields[f.key] || "" })
          }
        }
      }
    }
  }
  return params
}

/* ── Run Modal ──────────────────────────────────────────────────────── */
function RunModal({ tpl, onRun, onClose }: { tpl: WorkflowTemplate; onRun: (p: Record<string, any>) => void; onClose: () => void }) {
  const dynParams = extractDynParams(tpl.steps)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const p of dynParams) {
      init[p.key] = p.default || ""
    }
    return init
  })
  const [running, setRunning] = useState(false)

  const submit = async () => {
    const parsed: Record<string, any> = {}
    for (const p of dynParams) {
      const raw = values[p.key] || ""
      if (p.type === "int") parsed[p.key] = parseInt(raw, 10) || 0
      else parsed[p.key] = raw
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
          {dynParams.length > 0 ? dynParams.map(p => (
            <div className="wf-field" key={p.key}>
              <label>{p.label}</label>
              {p.type === "text" ? (
                <textarea className="wf-field-input" rows={3} placeholder={`輸入 ${p.label}`} value={values[p.key] || ""} onChange={e => setValues({ ...values, [p.key]: e.target.value })} />
              ) : (
                <input className="wf-field-input" placeholder={`輸入 ${p.label}`} value={values[p.key] || ""} onChange={e => setValues({ ...values, [p.key]: e.target.value })} />
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

/* ── Step Config Editor ─────────────────────────────────────────────── */
function StepConfigEditor({ step, onChange }: { step: WorkflowStep; onChange: (s: WorkflowStep) => void }) {
  const [stepType, setStepType] = useState(step.type)
  const [shellCmd, setShellCmd] = useState((step.config as any)?.command || "")
  const [noteApiIdx, setNoteApiIdx] = useState(() => {
    const path = (step.config as any)?.path || ""
    const found = NOTE_APIS.findIndex(a => a.path === path)
    return found >= 0 ? found : 0
  })
  const [noteFields, setNoteFields] = useState<Record<string, string>>(() => {
    const existing = (step.config as any)?.fields || {}
    return existing
  })

  // When step type changes, reset config
  const handleTypeChange = (newType: string) => {
    setStepType(newType)
    if (newType === "shell") {
      onChange({ type: "shell", name: step.name, config: { command: shellCmd } })
    } else if (newType === "note_api") {
      const apiDef = NOTE_APIS[0]
      setNoteApiIdx(0)
      setNoteFields({})
      onChange({ type: "note_api", name: step.name, config: { method: apiDef.method, path: apiDef.path, fields: {} } })
    }
  }

  // When note API selection changes
  const handleNoteApiChange = (idx: number) => {
    setNoteApiIdx(idx)
    const apiDef = NOTE_APIS[idx]
    const newFields: Record<string, string> = {}
    apiDef.fields.forEach(f => { newFields[f.key] = noteFields[f.key] || "" })
    setNoteFields(newFields)
    onChange({ type: "note_api", name: step.name, config: { method: apiDef.method, path: apiDef.path, fields: newFields } })
  }

  const handleNoteFieldChange = (key: string, val: string) => {
    const nf = { ...noteFields, [key]: val }
    setNoteFields(nf)
    const apiDef = NOTE_APIS[noteApiIdx]
    onChange({ type: "note_api", name: step.name, config: { method: apiDef.method, path: apiDef.path, fields: nf } })
  }

  return (
    <div className="wf-step-config">
      <div className="wf-step-type-row">
        <span className="wf-step-type-label">類型</span>
        <select className="wf-field-input wf-field-sm" value={stepType} onChange={e => handleTypeChange(e.target.value)}>
          <option value="shell">🐚 Shell 指令</option>
          <option value="note_api">📝 Note API</option>
        </select>
      </div>

      {stepType === "shell" && (
        <div className="wf-step-fields">
          <div className="wf-field">
            <label>指令</label>
            <textarea className="wf-field-input wf-code" rows={3} placeholder="例如: systemctl restart nginx" value={shellCmd} onChange={e => {
              setShellCmd(e.target.value)
              onChange({ type: "shell", name: step.name, config: { command: e.target.value } })
            }} />
          </div>
        </div>
      )}

      {stepType === "note_api" && (
        <div className="wf-step-fields">
          <div className="wf-field">
            <label>API 類型</label>
            <select className="wf-field-input" value={noteApiIdx} onChange={e => handleNoteApiChange(parseInt(e.target.value))}>
              {NOTE_APIS.map((a, i) => (
                <option key={i} value={i}>{a.method} {a.path} — {a.label}</option>
              ))}
            </select>
            <span className="wf-api-hint">
              <span className="wf-method-chip" style={{ background: NOTE_APIS[noteApiIdx]?.method === "POST" ? "#dcfce7" : NOTE_APIS[noteApiIdx]?.method === "DELETE" ? "#fee2e2" : "#dbeafe" }}>
                {NOTE_APIS[noteApiIdx]?.method}
              </span>
              <code>{NOTE_APIS[noteApiIdx]?.path}</code>
            </span>
          </div>

          {NOTE_APIS[noteApiIdx]?.fields.map(f => (
            <div className="wf-field" key={f.key}>
              <label>{f.label}</label>
              {f.type === "text" ? (
                <textarea className="wf-field-input" rows={3} placeholder={`輸入 ${f.label}`} value={noteFields[f.key] || ""} onChange={e => handleNoteFieldChange(f.key, e.target.value)} />
              ) : (
                <input className="wf-field-input" placeholder={`輸入 ${f.label}`} value={noteFields[f.key] || ""} onChange={e => handleNoteFieldChange(f.key, e.target.value)} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Edit Modal ─────────────────────────────────────────────────────── */
function EditModal({ tpl, onSave, onClose }: { tpl: WorkflowTemplate; onSave: (data: any) => void; onClose: () => void }) {
  const [name, setName] = useState(tpl.name)
  const [desc, setDesc] = useState(tpl.description)
  const [steps, setSteps] = useState<WorkflowStep[]>([...tpl.steps])

  const addStep = () => setSteps([...steps, { type: "shell", name: "", config: {} }])
  const removeStep = (i: number) => setSteps(steps.filter((_, j) => j !== i))
  const updateStep = (i: number, s: WorkflowStep) => { const n = [...steps]; n[i] = s; setSteps(n) }

  const save = () => {
    if (!name) return alert("請填寫名稱")
    onSave({ name, description: desc, parameters: [], steps })
  }

  return (
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal-lg" onClick={e => e.stopPropagation()}>
        <div className="wf-modal-header">
          <h3>✏️ 編輯流程</h3>
          <button className="wf-icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="wf-modal-body wf-scroll-body">
          {/* Basic Info */}
          <div className="wf-edit-block">
            <h4>基本資訊</h4>
            <div className="wf-field">
              <label>名稱 <span className="wf-req">*</span></label>
              <input className="wf-field-input" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="wf-field">
              <label>描述</label>
              <textarea className="wf-field-input" rows={2} value={desc} onChange={e => setDesc(e.target.value)} />
            </div>
          </div>


          {/* Steps */}
          <div className="wf-edit-block">
            <div className="wf-edit-section-header">
              <h4>執行步驟 ({steps.length})</h4>
              <button className="btn btn-sm" onClick={addStep}>+ 新增步驟</button>
            </div>
            {steps.length === 0 && <p className="wf-hint">沒有步驟，請新增。步驟詳細配置在建立後可以編輯。</p>}
            {steps.map((s, i) => (
              <div className="wf-edit-step" key={i}>
                <div className="wf-edit-step-header">
                  <span className="wf-step-num">#{i + 1}</span>
                  <input className="wf-field-input wf-field-sm" placeholder="步驟名稱" value={s.name} onChange={e => updateStep(i, { ...s, name: e.target.value })} style={{ flex: 1 }} />
                  <button className="wf-icon-btn" onClick={() => removeStep(i)}>✕</button>
                </div>
                <StepConfigEditor step={s} onChange={s2 => updateStep(i, s2)} />
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

/* ── Create Modal ───────────────────────────────────────────────────── */
function CreateModal({ onSave, onClose }: { onSave: (data: any) => void; onClose: () => void }) {
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")
  const [steps, setSteps] = useState<WorkflowStep[]>([])

  const addStep = () => setSteps([...steps, { type: "shell", name: "", config: {} }])
  const removeStep = (i: number) => setSteps(steps.filter((_, j) => j !== i))
  const updateStep = (i: number, s: WorkflowStep) => { const n = [...steps]; n[i] = s; setSteps(n) }

  const save = () => {
    if (!name) return alert("請填寫名稱")
    onSave({ name, description: desc, parameters: [], steps })
  }

  return (
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal-lg" onClick={e => e.stopPropagation()}>
        <div className="wf-modal-header">
          <h3>+ 新增流程</h3>
          <button className="wf-icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="wf-modal-body wf-scroll-body">
          <div className="wf-edit-block">
            <h4>基本資訊</h4>
            <div className="wf-field">
              <label>名稱 <span className="wf-req">*</span></label>
              <input className="wf-field-input" value={name} onChange={e => setName(e.target.value)} placeholder="例如: 部署更新" />
            </div>
            <div className="wf-field">
              <label>描述</label>
              <textarea className="wf-field-input" rows={2} value={desc} onChange={e => setDesc(e.target.value)} placeholder="簡述流程用途" />
            </div>
          </div>
          <div className="wf-edit-block">
            <div className="wf-edit-section-header">
              <h4>執行步驟 ({steps.length})</h4>
              <button className="btn btn-sm" onClick={addStep}>+ 新增步驟</button>
            </div>
            {steps.length === 0 && <p className="wf-hint">沒有步驟，請新增</p>}
            {steps.map((s, i) => (
              <div className="wf-edit-step" key={i}>
                <div className="wf-edit-step-header">
                  <span className="wf-step-num">#{i + 1}</span>
                  <input className="wf-field-input wf-field-sm" placeholder="步驟名稱" value={s.name} onChange={e => updateStep(i, { ...s, name: e.target.value })} style={{ flex: 1 }} />
                  <button className="wf-icon-btn" onClick={() => removeStep(i)}>✕</button>
                </div>
                <StepConfigEditor step={s} onChange={s2 => updateStep(i, s2)} />
              </div>
            ))}
          </div>
        </div>
        <div className="wf-modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={save}>💾 建立</button>
        </div>
      </div>
    </div>
  )
}

/* ── Template Row ───────────────────────────────────────────────────── */
function TplRow({ tpl, onRun, onEdit, onDelete }: { tpl: WorkflowTemplate; onRun: (t: WorkflowTemplate) => void; onEdit: (t: WorkflowTemplate) => void; onDelete: (id: string) => void }) {
  return (
    <div className="wf-tpl-row">
      <div className="wf-tpl-row-icon">⚡</div>
      <div className="wf-tpl-row-info">
        <div className="wf-tpl-row-name">{tpl.name}</div>
        <div className="wf-tpl-row-desc">{tpl.description}</div>
      </div>
      <div className="wf-tpl-row-steps">
        {tpl.steps.map((s, i) => (
          <span key={i} className="wf-step-chip">
            <span className="wf-step-chip-num">{i + 1}</span>
            {s.name}
          </span>
        ))}
      </div>
      <div className="wf-tpl-row-actions">
        <button className="btn btn-primary btn-sm" onClick={() => onRun(tpl)}>▶ 執行</button>
        <button className="btn btn-sm" onClick={() => onEdit(tpl)}>✏️ 編輯</button>
        <button className="btn btn-sm btn-danger" onClick={() => onDelete(tpl.id)}>🗑 刪除</button>
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
  const [showCreate, setShowCreate] = useState(false)
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

  const handleCreate = async (data: any) => {
    try {
      await api("/api/v1/workflows/templates", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })
      setShowCreate(false)
      fetchAll()
    } catch (e) { alert("建立失敗: " + (e as Error).message) }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("確定刪除此流程？")) return
    try {
      await api(`/api/v1/workflows/templates/${id}`, { method: "DELETE" })
      fetchAll()
    } catch (e) { alert("刪除失敗: " + (e as Error).message) }
  }

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
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ 新增流程</button>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <CreateModal onSave={handleCreate} onClose={() => setShowCreate(false)} />
      )}

      {/* Template List */}
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
          <div className="wf-tpl-list">
            {templates.map(t => (
              <TplRow key={t.id} tpl={t} onRun={setRunTpl} onEdit={setEditTpl} onDelete={handleDelete} />
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
