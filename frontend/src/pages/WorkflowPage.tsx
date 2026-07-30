import { useEffect, useState, useCallback } from "react"
import { api } from "../auth"
import type { WorkflowTemplate, WorkflowExecution, WorkflowParameter, WorkflowStep } from "../types"

// ── Icons ──────────────────────────────────────────────────────────────────

const STEP_ICONS: Record<string, string> = {
  llm: "🤖",
  api: "🌐",
  note_create: "📝",
  script: "⚙️",
}

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

// ── Sub-components ─────────────────────────────────────────────────────────

function TemplateCard({ tpl, onRun }: { tpl: WorkflowTemplate; onRun: (tpl: WorkflowTemplate) => void }) {
  return (
    <div className="wf-template-card">
      <div className="wf-template-header">
        <h3 className="wf-template-name">{tpl.name}</h3>
        <span className="wf-template-id">{tpl.id}</span>
      </div>
      <p className="wf-template-desc">{tpl.description}</p>
      <div className="wf-template-meta">
        <span className="wf-badge wf-badge-params">
          參數: {tpl.parameters.length}
        </span>
        <span className="wf-badge wf-badge-steps">
          步驟: {tpl.steps.length}
        </span>
      </div>
      <div className="wf-template-steps">
        {tpl.steps.map((s, i) => (
          <div key={i} className="wf-step-mini">
            <span className="wf-step-icon">{STEP_ICONS[s.type] || "📦"}</span>
            <span className="wf-step-name">{s.name}</span>
            <span className="wf-step-type">{s.type}</span>
          </div>
        ))}
      </div>
      <button className="btn btn-primary wf-run-btn" onClick={() => onRun(tpl)}>
        ▶ 執行
      </button>
    </div>
  )
}

function ParameterForm({
  parameters,
  values,
  onChange,
}: {
  parameters: WorkflowParameter[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  const renderField = (p: WorkflowParameter) => {
    const placeholder = p.description || p.name
    if (p.type === "list") {
      return (
        <div key={p.name} className="wf-param-field">
          <label>{p.name} {p.required && <span className="wf-required">*</span>}</label>
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
          <label>{p.name} {p.required && <span className="wf-required">*</span>}</label>
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
        <label>{p.name} {p.required && <span className="wf-required">*</span>}</label>
        <input
          type="text"
          placeholder={placeholder}
          value={values[p.name] || ""}
          onChange={(e) => onChange(p.name, e.target.value)}
        />
        <small className="wf-hint">{p.description}</small>
      </div>
    )
  }

  return (
    <div className="wf-params">
      {parameters.map(renderField)}
    </div>
  )
}

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
    // Parse list type params
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
          <button className="wf-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="wf-modal-body">
          <ParameterForm parameters={tpl.parameters} values={values} onChange={handleChange} />
        </div>
        <div className="wf-modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "執行中..." : "確認執行"}
          </button>
        </div>
      </div>
    </div>
  )
}

function ExecutionItem({ exec, templateName }: { exec: WorkflowExecution; templateName: string }) {
  const color = STATUS_COLORS[exec.status] || "#8b97a8"
  const label = STATUS_LABELS[exec.status] || exec.status

  return (
    <div className="wf-exec-item">
      <div className="wf-exec-status-dot" style={{ backgroundColor: color }}></div>
      <div className="wf-exec-info">
        <div className="wf-exec-title">
          {templateName || exec.template_id}
          <span className="wf-exec-status" style={{ color }}>{label}</span>
        </div>
        <div className="wf-exec-meta">
          <span>#{exec.id}</span>
          <span>{exec.user}</span>
          <span>{new Date(exec.started_at).toLocaleString("zh-Hant")}</span>
          {exec.completed_at && (
            <span>
              耗時: {((new Date(exec.completed_at).getTime() - new Date(exec.started_at).getTime()) / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function WorkflowPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [executions, setExecutions] = useState<WorkflowExecution[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [activeTab, setActiveTab] = useState<"templates" | "executions">("templates")

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await api<{ items: WorkflowTemplate[]; total: number }>("/api/v1/workflows/templates")
      setTemplates(res.items)
    } catch (e) {
      console.error("Failed to fetch templates:", e)
    }
  }, [])

  const fetchExecutions = useCallback(async () => {
    try {
      const res = await api<{ items: WorkflowExecution[]; total: number }>("/api/v1/workflows/executions?page_size=20")
      setExecutions(res.items)
    } catch (e) {
      console.error("Failed to fetch executions:", e)
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
    fetchExecutions()
  }, [fetchTemplates, fetchExecutions])

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

  const handleRunFromCard = (tpl: WorkflowTemplate) => {
    setSelectedTemplate(tpl)
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

      {activeTab === "templates" && (
        <div className="workflow-templates">
          {loading ? (
            <div className="wf-loading">載入中...</div>
          ) : templates.length === 0 ? (
            <div className="wf-empty">暫無流程模板</div>
          ) : (
            <div className="wf-template-grid">
              {templates.map((tpl) => (
                <TemplateCard key={tpl.id} tpl={tpl} onRun={handleRunFromCard} />
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "executions" && (
        <div className="workflow-executions">
          {executions.length === 0 ? (
            <div className="wf-empty">暫無執行記錄</div>
          ) : (
            <div className="wf-exec-list">
              {executions.map((exec) => (
                <ExecutionItem key={exec.id} exec={exec} templateName={
                  templates.find((t) => t.id === exec.template_id)?.name || ""
                } />
              ))}
            </div>
          )}
        </div>
      )}

      {selectedTemplate && (
        <RunModal
          tpl={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onRun={handleRun}
        />
      )}
    </div>
  )
}
