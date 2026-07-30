import { useEffect, useState, useCallback } from "react"
import { api } from "../auth"
import type {
  WorkflowTemplate,
  WorkflowExecution,
  WorkflowParameter,
  WorkflowStep,
  WorkflowExecutionDetail,
} from "../types"

// ── Constants ────────────────────────────────────────────────────────────────

const STEP_TYPES = [
  { value: "llm", label: "LLM 生成", icon: "🤖", desc: "呼叫 LLM 生成內容" },
  { value: "api", label: "API 呼叫", icon: "🌐", desc: "發送 HTTP 請求" },
  { value: "note_create", label: "建立筆記", icon: "📝", desc: "將結果寫入筆記系統" },
]

const PARAM_TYPES = ["str", "int", "number", "bool", "list"]

const STATUS_LABELS: Record<string, string> = {
  pending: "等待中",
  running: "執行中",
  completed: "已完成",
  failed: "失敗",
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#8b97a8",
  running: "#3b82f6",
  completed: "#10b981",
  failed: "#ef4444",
}

// ── Utility ──────────────────────────────────────────────────────────────────

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

function emptyParameter(): WorkflowParameter {
  return { name: "", type: "str", description: "", required: false, default: null }
}

function emptyStep(): WorkflowStep {
  return { type: "llm", name: "", config: {} }
}

// ── Sub-components ───────────────────────────────────────────────────────────

/* Template Card */
function TemplateCard({
  tpl,
  onRun,
  onEdit,
  onDelete,
}: {
  tpl: WorkflowTemplate
  onRun: (tpl: WorkflowTemplate) => void
  onEdit: (tpl: WorkflowTemplate) => void
  onDelete: (tpl: WorkflowTemplate) => void
}) {
  return (
    <div className="wf-template-card">
      <div className="wf-template-header">
        <h3 className="wf-template-name">{tpl.name}</h3>
        <span className="wf-template-id">{tpl.id}</span>
      </div>
      <p className="wf-template-desc">{tpl.description}</p>
      <div className="wf-template-meta">
        <span className="wf-badge wf-badge-params">參數: {tpl.parameters.length}</span>
        <span className="wf-badge wf-badge-steps">步驟: {tpl.steps.length}</span>
      </div>
      <div className="wf-template-steps">
        {tpl.steps.map((s, i) => (
          <div key={i} className="wf-step-mini">
            <span className="wf-step-icon">
              {STEP_TYPES.find((t) => t.value === s.type)?.icon || "📦"}
            </span>
            <span className="wf-step-name">{s.name}</span>
            <span className="wf-step-type">{s.type}</span>
          </div>
        ))}
      </div>
      <div className="wf-card-actions">
        <button className="btn btn-primary wf-run-btn" onClick={() => onRun(tpl)}>
          ▶ 執行
        </button>
        <button className="btn btn-sm" onClick={() => onEdit(tpl)}>✏️ 編輯</button>
        <button className="btn btn-sm btn-danger" onClick={() => onDelete(tpl)}>🗑 刪除</button>
      </div>
    </div>
  )
}

/* Parameter Editor Row */
function ParameterRow({
  p,
  index,
  onChange,
  onRemove,
}: {
  p: WorkflowParameter
  index: number
  onChange: (p: WorkflowParameter) => void
  onRemove: () => void
}) {
  return (
    <div className="wf-param-editor-row">
      <input
        className="wf-input-sm"
        placeholder="名稱"
        value={p.name}
        onChange={(e) => onChange({ ...p, name: e.target.value })}
      />
      <select
        className="wf-input-sm"
        value={p.type}
        onChange={(e) => onChange({ ...p, type: e.target.value })}
      >
        {PARAM_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <input
        className="wf-input-sm"
        placeholder="描述"
        value={p.description}
        onChange={(e) => onChange({ ...p, description: e.target.value })}
      />
      <label className="wf-check-label">
        <input type="checkbox" checked={p.required} onChange={(e) => onChange({ ...p, required: e.target.checked })} />
        必填
      </label>
      <button className="btn btn-sm btn-danger" onClick={onRemove} title="移除">✕</button>
    </div>
  )
}

/* Step Editor Row */
function StepEditorRow({
  s,
  index,
  onChange,
  onRemove,
}: {
  s: WorkflowStep
  index: number
  onChange: (s: WorkflowStep) => void
  onRemove: () => void
}) {
  const [configText, setConfigText] = useState(JSON.stringify(s.config, null, 2))

  const handleConfigChange = (val: string) => {
    setConfigText(val)
    try {
      onChange({ ...s, config: JSON.parse(val) })
    } catch {
      // ignore invalid JSON while typing
    }
  }

  return (
    <div className="wf-step-editor-row">
      <div className="wf-step-editor-header">
        <span className="wf-step-num">#{index + 1}</span>
        <select
          className="wf-input-sm"
          value={s.type}
          onChange={(e) => onChange({ ...s, type: e.target.value, config: {} })}
        >
          {STEP_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.icon} {t.label}
            </option>
          ))}
        </select>
        <input
          className="wf-input-sm"
          placeholder="步驟名稱"
          value={s.name}
          onChange={(e) => onChange({ ...s, name: e.target.value })}
        />
        <button className="btn btn-sm btn-danger" onClick={onRemove} title="移除">✕</button>
      </div>
      <div className="wf-step-config-area">
        <label className="wf-config-label">
          配置 (JSON) — {STEP_TYPES.find((t) => t.value === s.type)?.desc || ""}
        </label>
        <textarea
          className="wf-config-textarea"
          value={configText}
          onChange={(e) => handleConfigChange(e.target.value)}
          rows={4}
        />
      </div>
    </div>
  )
}

/* Template Editor Modal */
function TemplateEditor({
  tpl,
  onSave,
  onClose,
}: {
  tpl: WorkflowTemplate | null
  onSave: (tpl: WorkflowTemplateCreateData) => void
  onClose: () => void
}) {
  const isEdit = tpl !== null
  const [id, setId] = useState(tpl?.id ?? "")
  const [name, setName] = useState(tpl?.name ?? "")
  const [description, setDescription] = useState(tpl?.description ?? "")
  const [parameters, setParameters] = useState<WorkflowParameter[]>(tpl?.parameters ?? [])
  const [steps, setSteps] = useState<WorkflowStep[]>(tpl?.steps ?? [])

  const handleSave = () => {
    if (!id || !name) {
      alert("請填寫 ID 和名稱")
      return
    }
    onSave({ id, name, description, parameters, steps })
  }

  return (
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="wf-modal-header">
          <h3>{isEdit ? "編輯模板" : "新建模板"}</h3>
          <button className="wf-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="wf-modal-body wf-scroll-body">
          {/* Basic info */}
          <div className="wf-form-section">
            <h4>基本資訊</h4>
            <div className="wf-form-row">
              <label>
                ID
                <input
                  className="wf-input"
                  value={id}
                  onChange={(e) => setId(e.target.value.replace(/\s+/g, "-").toLowerCase())}
                  placeholder="例如: my-workflow"
                  disabled={isEdit}
                />
              </label>
              <label>
                名稱
                <input className="wf-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="模板名稱" />
              </label>
            </div>
            <label>
              描述
              <textarea className="wf-input" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </label>
          </div>

          {/* Parameters */}
          <div className="wf-form-section">
            <div className="wf-section-header">
              <h4>參數 ({parameters.length})</h4>
              <button
                className="btn btn-sm"
                onClick={() => setParameters([...parameters, emptyParameter()])}
              >
                + 新增參數
              </button>
            </div>
            {parameters.map((p, i) => (
              <ParameterRow
                key={i}
                p={p}
                index={i}
                onChange={(updated) => {
                  const next = [...parameters]
                  next[i] = updated
                  setParameters(next)
                }}
                onRemove={() => setParameters(parameters.filter((_, j) => j !== i))}
              />
            ))}
            {parameters.length === 0 && <p className="wf-hint">此模板不需要輸入參數</p>}
          </div>

          {/* Steps */}
          <div className="wf-form-section">
            <div className="wf-section-header">
              <h4>步驟 ({steps.length})</h4>
              <button className="btn btn-sm" onClick={() => setSteps([...steps, emptyStep()])}>
                + 新增步驟
              </button>
            </div>
            {steps.map((s, i) => (
              <StepEditorRow
                key={i}
                s={s}
                index={i}
                onChange={(updated) => {
                  const next = [...steps]
                  next[i] = updated
                  setSteps(next)
                }}
                onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
              />
            ))}
            {steps.length === 0 && <p className="wf-hint">此模板沒有步驟</p>}
          </div>
        </div>
        <div className="wf-modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            儲存
          </button>
        </div>
      </div>
    </div>
  )
}

/* Run Parameter Form */
function RunParameterForm({
  parameters,
  values,
  onChange,
}: {
  parameters: WorkflowParameter[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  return (
    <div className="wf-params">
      {parameters.map((p) => {
        const placeholder = p.description || p.name
        if (p.type === "list") {
          return (
            <div key={p.name} className="wf-param-field">
              <label>
                {p.name} {p.required && <span className="wf-required">*</span>}
              </label>
              <input
                type="text"
                placeholder={`逗號分隔, 如: ${placeholder}`}
                value={values[p.name] || ""}
                onChange={(e) => onChange(p.name, e.target.value)}
              />
              <small className="wf-hint">{p.description}</small>
            </div>
          )
        }
        if (p.type === "int" || p.type === "number") {
          return (
            <div key={p.name} className="wf-param-field">
              <label>
                {p.name} {p.required && <span className="wf-required">*</span>}
              </label>
              <input
                type="number"
                placeholder={placeholder}
                value={values[p.name] || ""}
                onChange={(e) => onChange(p.name, e.target.value)}
              />
            </div>
          )
        }
        return (
          <div key={p.name} className="wf-param-field">
            <label>
              {p.name} {p.required && <span className="wf-required">*</span>}
            </label>
            <input
              type="text"
              placeholder={placeholder}
              value={values[p.name] || ""}
              onChange={(e) => onChange(p.name, e.target.value)}
            />
            <small className="wf-hint">{p.description}</small>
          </div>
        )
      })}
    </div>
  )
}

/* Run Modal */
function RunModal({
  tpl,
  onClose,
  onRun,
}: {
  tpl: WorkflowTemplate
  onClose: () => void
  onRun: (params: Record<string, any>) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  const handleChange = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }))
  }

  const handleSubmit = async () => {
    const parsed: Record<string, any> = {}
    for (const p of tpl.parameters) {
      const raw = values[p.name] || ""
      if (p.type === "list") {
        parsed[p.name] = raw.split(",").map((s) => s.trim()).filter(Boolean)
      } else if (p.type === "int" || p.type === "number") {
        parsed[p.name] = parseInt(raw, 10) || 0
      } else {
        parsed[p.name] = raw
      }
    }
    setLoading(true)
    try {
      await onRun(parsed)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wf-modal-header">
          <h3>執行: {tpl.name}</h3>
          <button className="wf-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="wf-modal-body">
          {tpl.parameters.length > 0 ? (
            <RunParameterForm parameters={tpl.parameters} values={values} onChange={handleChange} />
          ) : (
            <p className="wf-hint">此模板不需要參數</p>
          )}
        </div>
        <div className="wf-modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "執行中..." : "確認執行"}
          </button>
        </div>
      </div>
    </div>
  )
}

/* Execution Detail Modal */
function ExecutionDetailModal({
  execId,
  onClose,
}: {
  execId: number
  onClose: () => void
}) {
  const [detail, setDetail] = useState<WorkflowExecutionDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<WorkflowExecutionDetail>(`/api/v1/workflows/executions/${execId}`)
      .then(setDetail)
      .catch((e) => console.error("Failed to fetch execution detail:", e))
      .finally(() => setLoading(false))
  }, [execId])

  if (loading) return null

  return (
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="wf-modal-header">
          <h3>
            執行 #{execId} — {detail?.template_name || detail?.template_id}
          </h3>
          <button className="wf-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="wf-modal-body wf-scroll-body">
          {detail && (
            <>
              {/* Summary */}
              <div className="wf-exec-summary">
                <div className="wf-exec-summary-item">
                  <span className="wf-exec-summary-label">狀態</span>
                  <span
                    className="wf-exec-status"
                    style={{
                      color: STATUS_COLORS[detail.status] || "#8b97a8",
                    }}
                  >
                    {STATUS_LABELS[detail.status] || detail.status}
                  </span>
                </div>
                <div className="wf-exec-summary-item">
                  <span className="wf-exec-summary-label">使用者</span>
                  <span>{detail.user}</span>
                </div>
                <div className="wf-exec-summary-item">
                  <span className="wf-exec-summary-label">開始時間</span>
                  <span>{new Date(detail.started_at).toLocaleString("zh-Hant")}</span>
                </div>
                {detail.completed_at && (
                  <div className="wf-exec-summary-item">
                    <span className="wf-exec-summary-label">完成時間</span>
                    <span>{new Date(detail.completed_at).toLocaleString("zh-Hant")}</span>
                  </div>
                )}
                <div className="wf-exec-summary-item">
                  <span className="wf-exec-summary-label">耗時</span>
                  <span>{detail.duration_seconds.toFixed(1)}s</span>
                </div>
              </div>

              {/* Parameters */}
              {Object.keys(detail.parameters).length > 0 && (
                <div className="wf-detail-section">
                  <h4>輸入參數</h4>
                  <pre className="wf-json-block">{JSON.stringify(detail.parameters, null, 2)}</pre>
                </div>
              )}

              {/* Steps */}
              <div className="wf-detail-section">
                <h4>步驟日志 ({detail.steps.length})</h4>
                {detail.steps.map((sr, i) => (
                  <div key={i} className="wf-exec-step-detail">
                    <div className="wf-step-detail-header">
                      <span className="wf-step-detail-num">#{i + 1}</span>
                      <span className="wf-step-detail-name">{sr.step}</span>
                      <span
                        className="wf-exec-status"
                        style={{
                          color: STATUS_COLORS[sr.status] || "#8b97a8",
                        }}
                      >
                        {STATUS_LABELS[sr.status] || sr.status}
                      </span>
                    </div>
                    {sr.error && <div className="wf-step-error">錯誤: {sr.error}</div>}
                    {sr.result && Object.keys(sr.result).length > 0 && (
                      <details className="wf-step-result-details">
                        <summary>查看結果</summary>
                        <pre className="wf-json-block">
                          {JSON.stringify(sr.result, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                ))}
                {detail.steps.length === 0 && <p className="wf-hint">沒有步驟記錄</p>}
              </div>

              {/* Error */}
              {detail.error && (
                <div className="wf-detail-section wf-error-section">
                  <h4>錯誤訊息</h4>
                  <pre className="wf-json-block wf-error-text">{detail.error}</pre>
                </div>
              )}
            </>
          )}
        </div>
        <div className="wf-modal-footer">
          <button className="btn" onClick={onClose}>
            關閉
          </button>
        </div>
      </div>
    </div>
  )
}

/* Execution Item */
function ExecutionItem({
  exec,
  templateName,
  onView,
}: {
  exec: WorkflowExecution
  templateName: string
  onView: (id: number) => void
}) {
  const color = STATUS_COLORS[exec.status] || "#8b97a8"
  const label = STATUS_LABELS[exec.status] || exec.status

  return (
    <div className="wf-exec-item" onClick={() => onView(exec.id)} style={{ cursor: "pointer" }}>
      <div className="wf-exec-status-dot" style={{ backgroundColor: color }}></div>
      <div className="wf-exec-info">
        <div className="wf-exec-title">
          {templateName || exec.template_id}
          <span className="wf-exec-status" style={{ color }}>
            {label}
          </span>
        </div>
        <div className="wf-exec-meta">
          <span>#{exec.id}</span>
          <span>{exec.user}</span>
          <span>{new Date(exec.started_at).toLocaleString("zh-Hant")}</span>
          {exec.completed_at && (
            <span>
              耗時:{" "}
              {((new Date(exec.completed_at).getTime() - new Date(exec.started_at).getTime()) / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Types for editor ─────────────────────────────────────────────────────────

interface WorkflowTemplateCreateData {
  id: string
  name: string
  description: string
  parameters: WorkflowParameter[]
  steps: WorkflowStep[]
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function WorkflowPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [executions, setExecutions] = useState<WorkflowExecution[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [activeTab, setActiveTab] = useState<"templates" | "executions">("templates")

  // Editor state
  const [editingTpl, setEditingTpl] = useState<WorkflowTemplate | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)

  // Execution detail
  const [viewingExecId, setViewingExecId] = useState<number | null>(null)

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await api<{ items: WorkflowTemplate[]; total: number }>(
        "/api/v1/workflows/templates"
      )
      setTemplates(res.items)
    } catch (e) {
      console.error("Failed to fetch templates:", e)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchExecutions = useCallback(async () => {
    try {
      const res = await api<{ items: WorkflowExecution[]; total: number }>(
        "/api/v1/workflows/executions?page_size=20"
      )
      setExecutions(res.items)
    } catch (e) {
      console.error("Failed to fetch executions:", e)
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
    fetchExecutions()
  }, [fetchTemplates, fetchExecutions])

  /* Run workflow */
  const handleRun = async (params: Record<string, any>) => {
    if (!selectedTemplate) return
    setRunning(true)
    try {
      await api("/api/v1/workflows/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: selectedTemplate.id, parameters: params }),
      })
      setSelectedTemplate(null)
      fetchExecutions()
    } catch (e) {
      console.error("Failed to run workflow:", e)
      alert("流程執行失敗: " + (e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  /* Create / Update template */
  const handleSaveTemplate = async (data: WorkflowTemplateCreateData) => {
    try {
      if (editingTpl) {
        await api("/api/v1/workflows/templates/" + editingTpl.id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        })
      } else {
        await api("/api/v1/workflows/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        })
      }
      setEditingTpl(null)
      setShowCreateModal(false)
      fetchTemplates()
    } catch (e) {
      console.error("Failed to save template:", e)
      alert("儲存失敗: " + (e as Error).message)
    }
  }

  /* Delete template */
  const handleDeleteTemplate = async (tpl: WorkflowTemplate) => {
    if (!confirm(`確定要刪除模板「${tpl.name}」嗎？`)) return
    try {
      await api("/api/v1/workflows/templates/" + tpl.id, { method: "DELETE" })
      fetchTemplates()
    } catch (e) {
      console.error("Failed to delete template:", e)
      alert("刪除失敗: " + (e as Error).message)
    }
  }

  /* Edit template */
  const handleEditTemplate = (tpl: WorkflowTemplate) => {
    setEditingTpl(tpl)
  }

  /* View execution detail */
  const handleViewExecution = (id: number) => {
    setViewingExecId(id)
  }

  return (
    <div className="page workflow-page">
      <div className="workflow-header">
        <h1 className="page-title">流程</h1>
        <p className="page-subtitle">定義、執行和管理自動化流程</p>
      </div>

      <div className="workflow-tabs">
        <button
          className={`wf-tab ${activeTab === "templates" ? "wf-tab-active" : ""}`}
          onClick={() => setActiveTab("templates")}
        >
          模板 ({templates.length})
        </button>
        <button
          className={`wf-tab ${activeTab === "executions" ? "wf-tab-active" : ""}`}
          onClick={() => setActiveTab("executions")}
        >
          執行記錄 ({executions.length})
        </button>
      </div>

      {/* ── Templates Tab ─────────────────────────────────────────────── */}
      {activeTab === "templates" && (
        <div className="workflow-templates">
          <div className="wf-toolbar">
            <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
              + 新建模板
            </button>
          </div>
          {loading ? (
            <div className="wf-loading">載入中...</div>
          ) : templates.length === 0 ? (
            <div className="wf-empty">暫無流程模板，點擊「新建模板」開始創建</div>
          ) : (
            <div className="wf-template-grid">
              {templates.map((tpl) => (
                <TemplateCard
                  key={tpl.id}
                  tpl={tpl}
                  onRun={setSelectedTemplate}
                  onEdit={handleEditTemplate}
                  onDelete={handleDeleteTemplate}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Executions Tab ────────────────────────────────────────────── */}
      {activeTab === "executions" && (
        <div className="workflow-executions">
          {executions.length === 0 ? (
            <div className="wf-empty">暫無執行記錄</div>
          ) : (
            <div className="wf-exec-list">
              {executions.map((exec) => (
                <ExecutionItem
                  key={exec.id}
                  exec={exec}
                  templateName={templates.find((t) => t.id === exec.template_id)?.name || ""}
                  onView={handleViewExecution}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Modals ────────────────────────────────────────────────────── */}

      {selectedTemplate && (
        <RunModal
          tpl={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onRun={handleRun}
        />
      )}

      {(editingTpl || showCreateModal) && (
        <TemplateEditor
          tpl={editingTpl}
          onSave={handleSaveTemplate}
          onClose={() => {
            setEditingTpl(null)
            setShowCreateModal(false)
          }}
        />
      )}

      {viewingExecId !== null && (
        <ExecutionDetailModal
          execId={viewingExecId}
          onClose={() => setViewingExecId(null)}
        />
      )}
    </div>
  )
}
