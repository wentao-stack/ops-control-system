import { useEffect, useState, useCallback } from "react"
import { api } from "../auth"
import type {
  WorkflowTemplate,
  WorkflowExecution,
  WorkflowExecutionDetail,
} from "../types"

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

// ── Execution Detail Modal ─────────────────────────────────────────────────

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
              <div className="wf-exec-summary">
                <div className="wf-exec-summary-item">
                  <span className="wf-exec-summary-label">狀態</span>
                  <span
                    className="wf-exec-status"
                    style={{ color: STATUS_COLORS[detail.status] || "#8b97a8" }}
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

              {Object.keys(detail.parameters).length > 0 && (
                <div className="wf-detail-section">
                  <h4>輸入參數</h4>
                  <pre className="wf-json-block">{JSON.stringify(detail.parameters, null, 2)}</pre>
                </div>
              )}

              <div className="wf-detail-section">
                <h4>步驟日志 ({detail.steps.length})</h4>
                {detail.steps.map((sr, i) => (
                  <div key={i} className="wf-exec-step-detail">
                    <div className="wf-step-detail-header">
                      <span className="wf-step-detail-num">#{i + 1}</span>
                      <span className="wf-step-detail-name">{sr.step}</span>
                      <span
                        className="wf-exec-status"
                        style={{ color: STATUS_COLORS[sr.status] || "#8b97a8" }}
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

// ── Run Modal ──────────────────────────────────────────────────────────────

function RunModal({
  tpl,
  onClose,
  onRun,
}: {
  tpl: WorkflowTemplate
  onClose: () => void
  onRun: (params: Record<string, any>) => void
}) {
  const [featureName, setFeatureName] = useState("")
  const [filesChanged, setFilesChanged] = useState("")
  const [description, setDescription] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    if (!featureName || !description) {
      alert("請填寫功能名稱和描述")
      return
    }
    setLoading(true)
    try {
      await onRun({
        feature_name: featureName,
        files_changed: filesChanged
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        description,
      })
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
          <div className="wf-param-field">
            <label>
              功能名稱 <span className="wf-required">*</span>
            </label>
            <input
              type="text"
              placeholder="例如: 工作流功能完善"
              value={featureName}
              onChange={(e) => setFeatureName(e.target.value)}
            />
          </div>
          <div className="wf-param-field">
            <label>修改文件</label>
            <input
              type="text"
              placeholder="逗號分隔, 如: main.py, WorkflowPage.tsx"
              value={filesChanged}
              onChange={(e) => setFilesChanged(e.target.value)}
            />
            <small className="wf-hint">逗號分隔多個文件</small>
          </div>
          <div className="wf-param-field">
            <label>
              變更描述 <span className="wf-required">*</span>
            </label>
            <textarea
              rows={4}
              placeholder="簡述本次變更的內容..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
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

// ── Main Page ──────────────────────────────────────────────────────────────

export default function WorkflowPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [executions, setExecutions] = useState<WorkflowExecution[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null)
  const [loading, setLoading] = useState(true)
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

  const handleRun = async (params: Record<string, any>) => {
    if (!selectedTemplate) return
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
    }
  }

  return (
    <div className="page workflow-page">
      <div className="workflow-header">
        <h1 className="page-title">流程</h1>
        <p className="page-subtitle">自動化流程 — 功能變更記錄</p>
      </div>

      {/* Templates */}
      <div className="workflow-templates">
        <h2 className="wf-section-title">可用流程</h2>
        {loading ? (
          <div className="wf-loading">載入中...</div>
        ) : (
          <div className="wf-template-grid">
            {templates.map((tpl) => (
              <div key={tpl.id} className="wf-template-card">
                <div className="wf-template-header">
                  <h3 className="wf-template-name">{tpl.name}</h3>
                </div>
                <p className="wf-template-desc">{tpl.description}</p>
                <div className="wf-card-actions">
                  <button
                    className="btn btn-primary wf-run-btn"
                    onClick={() => setSelectedTemplate(tpl)}
                  >
                    ▶ 執行
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Executions */}
      <div className="workflow-executions">
        <h2 className="wf-section-title">執行記錄</h2>
        {executions.length === 0 ? (
          <div className="wf-empty">暫無執行記錄</div>
        ) : (
          <div className="wf-exec-list">
            {executions.map((exec) => {
              const color = STATUS_COLORS[exec.status] || "#8b97a8"
              const label = STATUS_LABELS[exec.status] || exec.status
              const tplName =
                templates.find((t) => t.id === exec.template_id)?.name || exec.template_id

              return (
                <div
                  key={exec.id}
                  className="wf-exec-item"
                  onClick={() => setViewingExecId(exec.id)}
                  style={{ cursor: "pointer" }}
                >
                  <div className="wf-exec-status-dot" style={{ backgroundColor: color }}></div>
                  <div className="wf-exec-info">
                    <div className="wf-exec-title">
                      {tplName}
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
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      {selectedTemplate && (
        <RunModal
          tpl={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onRun={handleRun}
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
