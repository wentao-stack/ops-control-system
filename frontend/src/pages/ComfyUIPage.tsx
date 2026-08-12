import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../auth"
import { useTranslation } from "react-i18next"
import { prepareComfyWorkflowImage } from "../comfyImage"
import type {
  ComfyGenerateResponse,
  ComfyArtifact,
  ComfyJob,
  ComfyOutputItem,
  ComfyParamDef,
  ComfyStatus,
  ComfyWorkflowTemplate,
} from "../types"

const fmtVram = (bytes?: number) => bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "—"
const fmtElapsed = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`
}
type LiveProgress = {
  value: number; max: number; node?: string; nodeTitle?: string; status?: string; queuePosition?: number
}
const GALLERY_PAGE_SIZE = 8

const fmtDate = (value?: string | number) => {
  if (!value) return "—"
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-TW")
}

const defaultsOf = (workflow: ComfyWorkflowTemplate): Record<string, unknown> => {
  const defaults: Record<string, unknown> = {}
  for (const param of workflow.params) {
    if (param.default != null) defaults[param.key] = param.default
    else if (param.type === "number" || param.type === "slider") defaults[param.key] = param.min ?? 0
    else if (param.type === "seed") defaults[param.key] = -1
    else if (param.type === "boolean") defaults[param.key] = false
    else if (param.type === "select") defaults[param.key] = param.options?.[0] ?? ""
    else defaults[param.key] = ""
  }
  return defaults
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  queued: { label: "排隊中", cls: "comfy-st-queued" },
  running: { label: "生成中", cls: "comfy-st-running" },
  done: { label: "已完成", cls: "comfy-st-done" },
  error: { label: "失敗", cls: "comfy-st-error" },
  cancelled: { label: "已取消", cls: "comfy-st-cancelled" },
}

async function fetchMediaUrl(output: ComfyOutputItem): Promise<string | null> {
  const query = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder ?? "",
    view_type: output.type ?? "output",
  })
  try {
    const response = await api<{ url: string }>(`/api/v1/comfyui/media-url?${query}`, { method: "POST" })
    return response.url
  } catch {
    return null
  }
}

async function fetchThumbnailUrl(output: ComfyOutputItem): Promise<string | null> {
  const query = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder ?? "",
    view_type: output.type ?? "output",
  })
  try {
    const response = await api<{ url: string }>(`/api/v1/comfyui/thumbnail-url?${query}`, { method: "POST" })
    return response.url
  } catch {
    return null
  }
}

function ComfyOutputCard({
  output,
  onDelete,
}: {
  output: ComfyOutputItem
  onDelete: () => Promise<void>
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [loadPreview, setLoadPreview] = useState(output.kind === "image")

  useEffect(() => {
    if (!loadPreview) return
    let active = true
    setFailed(false)
    fetchMediaUrl(output).then(nextUrl => {
      if (!active) return
      if (nextUrl) setUrl(nextUrl)
      else setFailed(true)
    })
    return () => {
      active = false
    }
  }, [output.filename, output.subfolder, output.type, loadPreview])

  useEffect(() => {
    if (output.kind !== "video" && output.kind !== "gif") return
    let active = true
    fetchThumbnailUrl(output).then(nextUrl => {
      if (active) setThumbnailUrl(nextUrl)
    })
    return () => { active = false }
  }, [output.filename, output.subfolder, output.type, output.kind])

  useEffect(() => {
    setLoadPreview(output.kind === "image")
    setUrl(null)
    setThumbnailUrl(null)
  }, [output.filename, output.subfolder, output.type, output.kind])

  const remove = async () => {
    if (!window.confirm(`確定永久刪除作品「${output.filename}」？`)) return
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <article className="comfy-output-card">
      <div className="comfy-output-stage">
        {failed ? (
          <div className="comfy-output-placeholder">檔案不存在或載入中</div>
        ) : !url && thumbnailUrl ? (
          <button className="comfy-video-thumbnail" onClick={() => setLoadPreview(true)} title="播放影片">
            <img src={thumbnailUrl} alt={`${output.filename} 的縮圖`} loading="lazy" />
            <span>▶</span>
          </button>
        ) : !url ? (
          <div className="comfy-output-placeholder comfy-output-loading">
            {loadPreview ? "載入作品中…" : <button className="comfy-secondary-btn" onClick={() => setLoadPreview(true)}>載入預覽</button>}
          </div>
        ) : output.kind === "image" ? (
          <img src={url} alt={output.filename} loading="lazy" />
        ) : output.kind === "video" || output.kind === "gif" ? (
          <video src={url} controls preload="metadata" />
        ) : (
          <audio src={url} controls preload="metadata" />
        )}
        <span className="comfy-kind-badge">{output.kind}</span>
      </div>
      <div className="comfy-output-info">
        <span className="comfy-output-name" title={output.filename}>{output.filename}</span>
        <div className="comfy-output-actions">
          {url && <a className="comfy-icon-btn" href={url} download={output.filename} title="下載">↓</a>}
          {url && <a className="comfy-icon-btn" href={url} target="_blank" rel="noreferrer" title="開啟">↗</a>}
          <button className="comfy-icon-btn comfy-icon-danger" onClick={remove} disabled={deleting} title="刪除作品">
            {deleting ? "…" : "⌫"}
          </button>
        </div>
      </div>
    </article>
  )
}

function ParamInput({
  def,
  value,
  onChange,
  disabled,
}: {
  def: ComfyParamDef
  value: unknown
  onChange: (value: unknown) => void
  disabled: boolean
}) {
  const [preview, setPreview] = useState("")

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  let control
  if (def.type === "textarea") {
    control = (
      <textarea
        className="comfy-input comfy-textarea"
        placeholder={def.placeholder ?? ""}
        rows={def.key.includes("prompt") || def.key.includes("text") ? 5 : 3}
        value={String(value ?? "")}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
    )
  } else if (def.type === "text") {
    control = (
      <input className="comfy-input" type="text" value={String(value ?? "")} disabled={disabled}
        placeholder={def.placeholder ?? ""} onChange={event => onChange(event.target.value)} />
    )
  } else if (def.type === "number") {
    control = (
      <input className="comfy-input comfy-number" type="number" value={value == null ? "" : String(value)}
        min={def.min} max={def.max} step={def.step} disabled={disabled}
        onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))} />
    )
  } else if (def.type === "slider") {
    const numeric = Number(value ?? def.min ?? 0)
    control = (
      <div className="comfy-slider-row">
        <input type="range" min={def.min} max={def.max} step={def.step} value={numeric} disabled={disabled}
          onChange={event => onChange(Number(event.target.value))} />
        <span className="comfy-slider-value">{numeric}{def.unit ?? ""}</span>
      </div>
    )
  } else if (def.type === "select") {
    control = (
      <select className="comfy-input" value={String(value ?? "")} disabled={disabled}
        onChange={event => onChange(event.target.value)}>
        {(def.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    )
  } else if (def.type === "boolean") {
    control = (
      <label className="comfy-switch-row">
        <input type="checkbox" checked={Boolean(value)} disabled={disabled}
          onChange={event => onChange(event.target.checked)} />
        <span className="comfy-switch" />
        <span>{value ? "開啟" : "關閉"}</span>
      </label>
    )
  } else if (def.type === "seed") {
    control = (
      <div className="comfy-seed-row">
        <input className="comfy-input comfy-number" type="number" value={value == null ? "" : String(value)}
          disabled={disabled} onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))} />
        <button className="comfy-secondary-btn" disabled={disabled}
          onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))}>隨機</button>
      </div>
    )
  } else if (def.type === "image") {
    control = (
      <div className="comfy-image-upload">
        <div className="comfy-image-preview-wrap">
          {preview ? <img className="comfy-image-preview" src={preview} alt="輸入預覽" /> : (
            <div className="comfy-image-current">{value ? `目前：${String(value)}` : "尚未選擇圖片"}</div>
          )}
        </div>
        <div className="comfy-upload-actions">
          <label className="comfy-secondary-btn">
            上傳圖片（自動適配）
            <input type="file" accept="image/*" hidden disabled={disabled} onChange={event => {
              const file = event.target.files?.[0]
              if (!file) return
              if (preview) URL.revokeObjectURL(preview)
              setPreview(URL.createObjectURL(file))
              onChange({ __upload: true, file, name: file.name })
            }} />
          </label>
          {preview && <button className="comfy-secondary-btn" disabled={disabled} onClick={() => {
            URL.revokeObjectURL(preview)
            setPreview("")
            onChange("")
          }}>移除</button>}
        </div>
      </div>
    )
  } else {
    control = null
  }

  return (
    <div className="comfy-param">
      <label className="comfy-param-label">
        {def.label}{def.unit ? `（${def.unit}）` : ""}{def.required && <span className="comfy-required"> *</span>}
      </label>
      {control}
      {def.help && <div className="comfy-param-help">{def.help}</div>}
    </div>
  )
}

export function ComfyUIPage() {
  const { t } = useTranslation()

  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [templates, setTemplates] = useState<ComfyWorkflowTemplate[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [jobs, setJobs] = useState<ComfyJob[]>([])
  const [artifacts, setArtifacts] = useState<ComfyArtifact[]>([])
  const [artifactTotal, setArtifactTotal] = useState(0)
  const [artifactPage, setArtifactPage] = useState(1)
  const [generating, setGenerating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<LiveProgress | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [workflowQuery, setWorkflowQuery] = useState("")
  const [jobFilter, setJobFilter] = useState("all")
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [actionBusy, setActionBusy] = useState("")
  const abortRef = useRef<AbortController | null>(null)

  const template = templates.find(item => item.id === selectedId) ?? templates[0] ?? null
  const filteredTemplates = useMemo(() => {
    const query = workflowQuery.trim().toLowerCase()
    if (!query) return templates
    return templates.filter(item => `${item.name} ${item.filename ?? ""} ${item.model ?? ""}`.toLowerCase().includes(query))
  }, [templates, workflowQuery])
  const filteredJobs = useMemo(() => jobs.filter(job => jobFilter === "all" || job.status === jobFilter), [jobs, jobFilter])
  const doneJobs = jobs.filter(job => job.outputs.length > 0)

  const loadStatus = useCallback(async () => {
    try { setStatus(await api<ComfyStatus>("/api/v1/comfyui/status")) } catch { /* status polling is best effort */ }
  }, [])
  const loadJobs = useCallback(async () => {
    try {
      const response = await api<{ jobs: ComfyJob[] }>("/api/v1/comfyui/jobs?limit=50")
      setJobs(response.jobs)
    } catch { /* history polling is best effort */ }
  }, [])
  const loadArtifacts = useCallback(async (page = artifactPage, refresh = false) => {
    try {
      const offset = (page - 1) * GALLERY_PAGE_SIZE
      const response = await api<{ artifacts: ComfyArtifact[]; total: number }>(`/api/v1/comfyui/artifacts?offset=${offset}&limit=${GALLERY_PAGE_SIZE}&refresh=${refresh}`)
      setArtifacts(response.artifacts)
      setArtifactTotal(response.total)
    } catch { /* gallery polling is best effort */ }
  }, [artifactPage])
  const loadTemplates = useCallback(async (showFeedback = false) => {
    setSyncing(true)
    try {
      const response = await api<{ templates: ComfyWorkflowTemplate[] }>("/api/v1/comfyui/workflows")
      setTemplates(response.templates)
      setSelectedId(previous => previous && response.templates.some(item => item.id === previous)
        ? previous
        : response.templates.find(item => item.runnable)?.id ?? response.templates[0]?.id ?? "")
      if (showFeedback) setNotice(`已同步 ${response.templates.length} 個工作流`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSyncing(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
    loadTemplates()
    loadJobs()
    loadArtifacts()
    const timer = window.setInterval(() => { loadStatus(); loadJobs() }, 15_000)
    return () => window.clearInterval(timer)
  }, [loadStatus, loadTemplates, loadJobs, loadArtifacts])

  useEffect(() => {
    if (!template) return
    setParams(defaultsOf(template))
    setShowAdvanced(false)
    setError("")
  }, [template?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const running = jobs.find(job => job.status === "queued" || job.status === "running")
    if (running && !activeJobId) {
      setActiveJobId(running.id)
      setGenerating(true)
      if (running.step_max) {
        setProgress({
          value: running.step_value ?? 0, max: running.step_max,
          node: running.current_node, nodeTitle: running.current_node_title,
        })
      }
    }
  }, [jobs, activeJobId])

  useEffect(() => {
    if (!activeJobId) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeJobId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(""), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const handleGenerate = async () => {
    if (!template || !template.runnable || generating) return
    setError("")
    setNotice("")
    let finalParams = { ...params }

    for (const [key, value] of Object.entries(params)) {
      if (!value || typeof value !== "object" || !("__upload" in value)) continue
      const upload = value as { file?: unknown }
      if (!(upload.file instanceof File)) continue
      setUploading(true)
      try {
        const prepared = await prepareComfyWorkflowImage(upload.file)
        const form = new FormData()
        form.append("file", prepared)
        const result = await api<{ filename: string }>("/api/v1/comfyui/upload", { method: "POST", body: form })
        finalParams = { ...finalParams, [key]: result.filename }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
        setUploading(false)
        return
      }
    }
    setUploading(false)

    for (const definition of template.params) {
      const value = finalParams[definition.key]
      if (definition.required && (value === undefined || value === null || value === "")) {
        setError(`請填寫「${definition.label}」`)
        return
      }
    }

    setGenerating(true)
    setProgress(null)
    try {
      const result = await api<ComfyGenerateResponse>("/api/v1/comfyui/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: template.id, params: finalParams }),
      })
      setActiveJobId(result.job_id)
      setNotice("任務已加入 ComfyUI 佇列")
      await loadJobs()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setGenerating(false)
    }
  }

  useEffect(() => {
    if (!activeJobId) return
    let cancelled = false
    const controller = new AbortController()
    abortRef.current = controller
    ;(async () => {
      try {
        const response = await api<Response>(`/api/v1/comfyui/jobs/${activeJobId}/events`, { signal: controller.signal })
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (!cancelled) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          let boundary
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const message = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            for (const line of message.split("\n")) {
              if (!line.startsWith("data: ")) continue
              const event = JSON.parse(line.slice(6))
              if (event.event === "progress") {
                setError("")
                setProgress({
                  value: event.value, max: event.max, node: event.node,
                  nodeTitle: event.node_title,
                })
              } else if (event.event === "executing") {
                setProgress(previous => ({
                  value: previous && previous.node === event.node ? previous.value : 0,
                  max: previous && previous.node === event.node ? previous.max : 0,
                  node: event.node, nodeTitle: event.node_title,
                  status: "running",
                }))
              } else if (event.event === "heartbeat") {
                setProgress(previous => ({
                  ...(previous ?? { value: 0, max: 0 }),
                  status: event.status, queuePosition: event.queue_position,
                }))
              } else if (event.event === "done" || event.event === "error") {
                setGenerating(false)
                setActiveJobId(null)
                setProgress(event.event === "done" ? { value: 100, max: 100 } : null)
                if (event.event === "error") setError(event.message || "生成失敗")
                await loadJobs()
                if (event.event === "done") await loadArtifacts(artifactPage, true)
              }
            }
          }
        }
      } catch {
        if (!cancelled) {
          setGenerating(false)
          setActiveJobId(null)
          setError("進度連線中斷；任務狀態會由背景輪詢更新")
        }
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [activeJobId, loadJobs])

  const handleCancel = async (job: ComfyJob) => {
    if (!window.confirm("確定取消目前的生成任務？")) return
    setActionBusy(`cancel-${job.id}`)
    try {
      await api(`/api/v1/comfyui/jobs/${job.id}/cancel`, { method: "POST" })
      abortRef.current?.abort()
      setActiveJobId(null)
      setGenerating(false)
      setProgress(null)
      setNotice("任務已取消")
      await loadJobs()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const handleDeleteJob = async (job: ComfyJob) => {
    const withFiles = job.outputs.length > 0
    const message = withFiles
      ? `刪除「${job.workflow_name}」記錄及 ${job.outputs.length} 個作品檔案？此操作無法復原。`
      : `刪除「${job.workflow_name}」記錄？`
    if (!window.confirm(message)) return
    setActionBusy(`delete-${job.id}`)
    try {
      await api(`/api/v1/comfyui/jobs/${job.id}?delete_outputs=true`, { method: "DELETE" })
      setNotice("記錄與作品已刪除")
      await loadJobs()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const handleDeleteOutput = async (job: ComfyJob, outputIndex: number) => {
    try {
      await api(`/api/v1/comfyui/jobs/${job.id}/outputs/${outputIndex}`, { method: "DELETE" })
      setNotice("作品已刪除")
      await loadJobs()
      await loadArtifacts()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const handleDeleteArtifact = async (artifact: ComfyArtifact) => {
    const query = new URLSearchParams({ filename: artifact.filename, subfolder: artifact.subfolder ?? "" })
    try {
      await api(`/api/v1/comfyui/artifacts?${query}`, { method: "DELETE" })
      setNotice("作品已刪除")
      const remainingOnPage = artifacts.length - 1
      const nextPage = remainingOnPage === 0 && artifactPage > 1 ? artifactPage - 1 : artifactPage
      if (nextPage !== artifactPage) setArtifactPage(nextPage)
      await loadArtifacts(nextPage)
      await loadJobs()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const galleryPages = Math.max(1, Math.ceil(artifactTotal / GALLERY_PAGE_SIZE))
  const changeGalleryPage = (nextPage: number) => {
    if (nextPage < 1 || nextPage > galleryPages || nextPage === artifactPage) return
    setArtifactPage(nextPage)
    void loadArtifacts(nextPage)
  }

  const handleRerun = (job: ComfyJob) => {
    const target = templates.find(item => item.id === job.workflow_id)
    if (!target) {
      setError("原工作流已從 ComfyUI 移除，無法重跑")
      return
    }
    setSelectedId(job.workflow_id)
    setParams({ ...defaultsOf(target), ...job.params })
    setNotice("已載入上次使用的參數")
  }

  const handleRenameWorkflow = async () => {
    if (!template) return
    const currentName = template.filename?.split("/").pop()?.replace(/\.json$/i, "") ?? template.name
    const name = window.prompt("輸入新的工作流檔名（可省略 .json）", currentName)
    if (name === null) return
    setActionBusy("rename-workflow")
    setError("")
    try {
      const result = await api<{ id: string; filename: string }>(`/api/v1/comfyui/workflows/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      await loadTemplates()
      setSelectedId(result.id)
      setNotice(`工作流已重新命名為 ${result.filename}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const handleDeleteWorkflow = async () => {
    if (!template) return
    if (!window.confirm(`確定刪除工作流「${template.name}」？此操作無法復原。`)) return
    setActionBusy("delete-workflow")
    setError("")
    try {
      await api(`/api/v1/comfyui/workflows/${template.id}`, { method: "DELETE" })
      setSelectedId("")
      await loadTemplates()
      setNotice("工作流已刪除")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const handleFreeMemory = async () => {
    setActionBusy("free")
    try {
      await api("/api/v1/comfyui/free", { method: "POST" })
      setNotice("已要求 ComfyUI 卸載模型並釋放顯存")
      window.setTimeout(loadStatus, 1000)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const visibleParams = template?.params.filter(param => showAdvanced || !param.advanced) ?? []
  const groupedParams = visibleParams.reduce<Record<string, ComfyParamDef[]>>((groups, param) => {
    const title = param.node_title || "工作流參數"
    ;(groups[title] ||= []).push(param)
    return groups
  }, {})
  const advancedCount = template?.params.filter(param => param.advanced).length ?? 0
  const progressPercent = progress?.max ? Math.round(progress.value / progress.max * 100) : 0
  const activeJob = jobs.find(job => job.id === activeJobId)
  const elapsedSeconds = activeJob?.created_at
    ? (clock - new Date(activeJob.created_at).getTime()) / 1000 : 0
  const phaseLabel = progress?.queuePosition
    ? `排隊第 ${progress.queuePosition} 位`
    : progress?.nodeTitle || (progress?.node ? `節點 ${progress.node}` : "等待 ComfyUI 回報階段")
  const stepLabel = progress?.max ? `${progress.value} / ${progress.max} · ${progressPercent}%` : "執行中"

  return (
    <div className="comfy-page">
      <header className="comfy-hero">
        <div>
          <div className="comfy-eyebrow">GENERATIVE WORKSPACE</div>
          <h1>ComfyUI 創作工作台</h1>
          <p>自動同步 ComfyUI 工作流，集中管理參數、任務與生成作品。</p>
        </div>
        <div className="comfy-hero-actions">
          <button className="comfy-secondary-btn" onClick={handleFreeMemory} disabled={actionBusy === "free" || Boolean(activeJobId)}>
            {actionBusy === "free" ? "釋放中…" : "釋放顯存"}
          </button>
          <button className="comfy-primary-btn" onClick={() => loadTemplates(true)} disabled={syncing}>
            {syncing ? "同步中…" : "同步工作流"}
          </button>
        </div>
      </header>

      <div className="comfy-statusbar">
        <div className="comfy-status-main">
          <span className={`comfy-status-dot ${status?.online ? "comfy-online" : "comfy-offline"}`} />
          <strong>{status?.online ? "ComfyUI 已連線" : "ComfyUI 離線"}</strong>
          {status?.comfyui_version && <span>v{status.comfyui_version}</span>}
        </div>
        {status?.devices?.map(device => (
          <div className="comfy-status-stat" key={device.name}>
            <span>GPU 顯存</span><strong>{fmtVram(device.vram_free)} / {fmtVram(device.vram_total)}</strong>
          </div>
        ))}
        <div className="comfy-status-stat"><span>執行中</span><strong>{status?.queue_running ?? 0}</strong></div>
        <div className="comfy-status-stat"><span>排隊</span><strong>{status?.queue_pending ?? 0}</strong></div>
      </div>

      {(error || notice) && (
        <div className={error ? "comfy-toast comfy-toast-error" : "comfy-toast comfy-toast-success"}>
          <span>{error || notice}</span>
          <button onClick={() => { setError(""); setNotice("") }}>×</button>
        </div>
      )}

      <div className="comfy-workspace">
        <aside className="comfy-workflows-panel">
          <div className="comfy-panel-heading">
            <div><span className="comfy-section-kicker">LIBRARY</span><h2>工作流</h2></div>
            <span className="comfy-count">{templates.length}</span>
          </div>
          <div className="comfy-search-wrap">
            <span>⌕</span>
            <input value={workflowQuery} onChange={event => setWorkflowQuery(event.target.value)} placeholder="搜尋工作流或模型" />
          </div>
          <div className="comfy-workflow-list">
            {filteredTemplates.map(item => (
              <button key={item.id} className={`comfy-workflow-card ${item.id === template?.id ? "is-active" : ""} ${!item.runnable ? "is-disabled" : ""}`}
                onClick={() => setSelectedId(item.id)}>
                <div className="comfy-workflow-card-top">
                  <span className="comfy-workflow-icon">{item.icon}</span>
                  <span className="comfy-workflow-name">{item.name}</span>
                  <span className={`comfy-format-badge ${item.workflow_format}`}>{item.workflow_format.toUpperCase()}</span>
                </div>
                <div className="comfy-workflow-file" title={item.filename}>{item.filename}</div>
                <div className="comfy-workflow-meta">
                  <span>{item.node_count} 節點</span>
                  <span>{item.params.length} 參數</span>
                  <span>{item.runnable ? "可執行" : "需處理"}</span>
                </div>
              </button>
            ))}
            {!filteredTemplates.length && <div className="comfy-empty-state">找不到符合條件的工作流</div>}
          </div>
        </aside>

        <main className="comfy-editor-panel">
          {template ? (
            <>
              <div className="comfy-editor-header">
                <div>
                  <div className="comfy-editor-title-row"><span>{template.icon}</span><h2>{template.name}</h2></div>
                  <p>{template.filename} · 更新於 {fmtDate(template.updated_at)}</p>
                </div>
                <div className="comfy-editor-actions">
                  <button className="comfy-icon-btn" onClick={handleRenameWorkflow} disabled={Boolean(actionBusy)} title="重新命名工作流">✎</button>
                  <button className="comfy-icon-btn comfy-icon-danger" onClick={handleDeleteWorkflow} disabled={Boolean(actionBusy)} title="刪除工作流">⌫</button>
                  <span className={`comfy-ready-badge ${template.runnable ? "ready" : "blocked"}`}>
                    {template.runnable ? "READY" : "BLOCKED"}
                  </span>
                </div>
              </div>

              {!template.runnable ? (
                <div className="comfy-blocked-card">
                  <strong>此工作流已識別，但無法直接執行</strong>
                  <p>{template.disabled_reason}</p>
                  <span>若包含子圖，請在 ComfyUI 中使用「匯出 API 格式」另存到 workflows 目錄。</span>
                </div>
              ) : (
                <>
                  <div className="comfy-parameter-toolbar">
                    <div>
                      <strong>生成參數</strong>
                      <span>{visibleParams.length} / {template.params.length} 個欄位</span>
                    </div>
                    {advancedCount > 0 && (
                      <button className={`comfy-text-btn ${showAdvanced ? "active" : ""}`} onClick={() => setShowAdvanced(value => !value)}>
                        {showAdvanced ? "隱藏進階設定" : `顯示 ${advancedCount} 個進階設定`}
                      </button>
                    )}
                  </div>
                  <div className="comfy-form-fields">
                    {Object.entries(groupedParams).map(([group, definitions]) => (
                      <section className="comfy-param-group" key={group}>
                        <div className="comfy-param-group-title"><span>{group}</span><small>NODE {definitions[0]?.node_id}</small></div>
                        <div className="comfy-param-grid">
                          {definitions.map(definition => (
                            <ParamInput key={definition.key} def={definition} value={params[definition.key]}
                              disabled={generating || uploading}
                              onChange={value => setParams(current => ({ ...current, [definition.key]: value }))} />
                          ))}
                        </div>
                      </section>
                    ))}
                    {!visibleParams.length && <div className="comfy-empty-state">此工作流沒有可調整參數，將使用已儲存設定執行。</div>}
                  </div>
                  <div className="comfy-generate-dock">
                    <div><strong>{template.output_kind.toUpperCase()}</strong><span>{template.model || "使用工作流內模型"}</span></div>
                    <button className="comfy-generate-btn" onClick={handleGenerate}
                      disabled={generating || uploading || !status?.online}>
                      {uploading ? "正在上傳…" : generating ? "正在生成…" : "開始生成"}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : <div className="comfy-empty-state">ComfyUI workflows 目錄目前沒有 JSON 工作流。</div>}
        </main>

        <aside className="comfy-activity-panel">
          <div className="comfy-panel-heading">
            <div><span className="comfy-section-kicker">ACTIVITY</span><h2>任務</h2></div>
            <button className="comfy-icon-btn" onClick={loadJobs} title="重新整理">↻</button>
          </div>

          {activeJobId && (
            <div className="comfy-progress-box">
              <div className="comfy-progress-head"><span>目前階段</span><strong>{stepLabel}</strong></div>
              <div className="comfy-progress-phase" title={phaseLabel}>{phaseLabel}</div>
              <div className="comfy-progress-track"><div className={`comfy-progress-fill ${!progress?.max ? "is-indeterminate" : ""}`}
                style={progress?.max ? { width: `${progressPercent}%` } : undefined} /></div>
              <div className="comfy-progress-metrics">
                <span>目前節點進度</span>
                <span>已耗時 {fmtElapsed(elapsedSeconds)}</span>
              </div>
              <small>步數為 ComfyUI 目前節點的實際 N/M；切換解碼、合成等階段時會重新計算。</small>
            </div>
          )}

          <div className="comfy-job-filters">
            {[['all', '全部'], ['running', '生成中'], ['done', '完成'], ['error', '失敗']].map(([value, label]) => (
              <button key={value} className={jobFilter === value ? "active" : ""} onClick={() => setJobFilter(value)}>{label}</button>
            ))}
          </div>

          <div className="comfy-jobs">
            {filteredJobs.map(job => {
              const meta = STATUS_META[job.status] ?? { label: job.status, cls: "" }
              const running = job.status === "queued" || job.status === "running"
              return (
                <article key={job.id} className={`comfy-job-item ${job.id === activeJobId ? "is-active" : ""}`}>
                  <div className="comfy-job-top">
                    <span className="comfy-job-name" title={job.workflow_name}>{job.workflow_name}</span>
                    <span className={`comfy-status-chip ${meta.cls}`}>{meta.label}</span>
                  </div>
                  <div className="comfy-job-date">{fmtDate(job.created_at)} · {job.outputs.length} 個作品</div>
                  {job.error && <div className="comfy-job-error" title={job.error}>{job.error}</div>}
                  {running && job.current_node_title && (
                    <div className="comfy-job-progress">{job.current_node_title}{job.step_max ? ` · ${job.step_value ?? 0}/${job.step_max}` : ""}</div>
                  )}
                  <div className="comfy-job-actions">
                    {!running && <button onClick={() => handleRerun(job)}>重跑</button>}
                    {running && <button className="danger" disabled={actionBusy === `cancel-${job.id}`} onClick={() => handleCancel(job)}>取消</button>}
                    {!running && <button className="danger" disabled={actionBusy === `delete-${job.id}`} onClick={() => handleDeleteJob(job)}>刪除</button>}
                  </div>
                </article>
              )
            })}
            {!filteredJobs.length && <div className="comfy-empty-state">此分類尚無任務</div>}
          </div>
        </aside>
      </div>

      <section className="comfy-gallery-section">
        <div className="comfy-gallery-header">
          <div><span className="comfy-section-kicker">CREATIONS</span><h2>作品庫</h2></div>
          <div className="comfy-gallery-heading-actions">
            <span>{artifactTotal} 個作品</span>
            <button className="comfy-icon-btn" onClick={() => loadArtifacts(artifactPage, true)} title="重新掃描 ComfyUI 作品">↻</button>
          </div>
        </div>
        {artifacts.length ? (
          <div className="comfy-gallery">
            {artifacts.map(artifact => (
              <ComfyOutputCard key={`${artifact.subfolder ?? ""}/${artifact.filename}`} output={artifact}
                onDelete={() => handleDeleteArtifact(artifact)} />
            ))}
          </div>
        ) : <div className="comfy-gallery-empty"><span>✦</span><strong>還沒有作品</strong><p>ComfyUI output 目錄中的作品會自動顯示在這裡。</p></div>}
        {artifactTotal > GALLERY_PAGE_SIZE && (
          <nav className="comfy-gallery-pagination" aria-label="作品庫分頁">
            <button className="comfy-secondary-btn" onClick={() => changeGalleryPage(artifactPage - 1)} disabled={artifactPage === 1}>上一頁</button>
            <span>第 {artifactPage} / {galleryPages} 頁</span>
            <button className="comfy-secondary-btn" onClick={() => changeGalleryPage(artifactPage + 1)} disabled={artifactPage === galleryPages}>下一頁</button>
          </nav>
        )}
      </section>
    </div>
  )
}