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

const STATUS_META = (t: (key: string) => string): Record<string, { label: string; cls: string }> => ({
  queued: { label: t("comfyui.status.queued"), cls: "comfy-st-queued" },
  running: { label: t("comfyui.status.generating"), cls: "comfy-st-running" },
  done: { label: t("comfyui.status.completed"), cls: "comfy-st-done" },
  error: { label: t("comfyui.status.failed"), cls: "comfy-st-error" },
  cancelled: { label: t("comfyui.status.cancelled"), cls: "comfy-st-cancelled" },
})

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
  selected,
  onSelectedChange,
  batchDeleting,
}: {
  output: ComfyOutputItem
  onDelete: () => Promise<void>
  selected: boolean
  onSelectedChange: (selected: boolean) => void
  batchDeleting: boolean
}) {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [loadPreview, setLoadPreview] = useState(output.kind === "image")
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)

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
    if (!window.confirm(t("comfyui.card.confirmDelete"))) return
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
    }
  }

  const handlePublish = async () => {
    setPublishing(true)
    try {
      await api("/api/v1/posts/publish-from-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: "comfyui",
          source_id: `${output.subfolder ?? ""}/${output.filename}`,
          title: output.filename.replace(/\.[^.]+$/, ""),
          cover_image: url ?? undefined,
        }),
      })
      setPublished(true)
    } catch (e: any) {
      alert(`發布失敗: ${e.message}`)
    } finally {
      setPublishing(false)
    }
  }

  return (
    <article className={`comfy-output-card${selected ? " is-selected" : ""}`}>
      <div className="comfy-output-stage">
        <label className="comfy-output-select" title={t("comfyui.card.selectTitle")}>
          <input type="checkbox" checked={selected} onChange={event => onSelectedChange(event.target.checked)} disabled={batchDeleting} />
          <span>{t("comfyui.card.select")}</span>
        </label>
        {failed ? (
          <div className="comfy-output-placeholder">{t("comfyui.card.fileNotFound")}</div>
        ) : !url && thumbnailUrl ? (
          <button className="comfy-video-thumbnail" onClick={() => setLoadPreview(true)} title={t("comfyui.playVideo")}>
            <img src={thumbnailUrl} alt={t("comfyui.thumbnail")} loading="lazy" />
            <span>▶</span>
          </button>
        ) : !url ? (
          <div className="comfy-output-placeholder comfy-output-loading">
            {loadPreview ? t("comfyui.loadingPreview") : <button className="comfy-secondary-btn" onClick={() => setLoadPreview(true)}>{t("comfyui.loadPreview")}</button>}
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
          {url && <a className="comfy-icon-btn" href={url} download={output.filename} title={t("comfyui.download")}>↓</a>}
          {url && <a className="comfy-icon-btn" href={url} target="_blank" rel="noreferrer" title={t("comfyui.open")}>↗</a>}
          <button className="comfy-icon-btn" onClick={handlePublish} disabled={publishing} title="發布到首頁" style={{ color: published ? "#22c55e" : "#3b82f6" }}>
            {publishing ? "⏳" : published ? "✓" : "📤"}
          </button>
          <button className="comfy-delete-btn" onClick={remove} disabled={deleting || batchDeleting} title={t("comfyui.deleteArtifact")}>
            {deleting ? t("comfyui.deleting") : t("comfyui.delete")}
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
  const { t } = useTranslation()
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
        <span>{value ? t("comfyui.enabled") : t("comfyui.disabled")}</span>
      </label>
    )
  } else if (def.type === "seed") {
    control = (
      <div className="comfy-seed-row">
        <input className="comfy-input comfy-number" type="number" value={value == null ? "" : String(value)}
          disabled={disabled} onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))} />
        <button className="comfy-secondary-btn" disabled={disabled}
          onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))}>{t("comfyui.random")}</button>
      </div>
    )
  } else if (def.type === "image") {
    control = (
      <div className="comfy-image-upload">
        <div className="comfy-image-preview-wrap">
          {preview ? <img className="comfy-image-preview" src={preview} alt={t("comfyui.inputPreview")} /> : (
            <div className="comfy-image-current">{value ? t("comfyui.currentImage") : t("comfyui.noImageSelected")}</div>
          )}
        </div>
        <div className="comfy-upload-actions">
          <label className="comfy-secondary-btn">
            {t("comfyui.uploadImage")}
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
          }}>{t("comfyui.remove")}</button>}
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
  const [selectedArtifactKeys, setSelectedArtifactKeys] = useState<Set<string>>(() => new Set())
  const [batchDeleting, setBatchDeleting] = useState(false)
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
      if (showFeedback) setNotice(t("comfyui.syncedTemplates"))
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
        setError(t("comfyui.fillRequired"))
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
      setNotice(t("comfyui.taskQueued"))
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
                if (event.event === "error") setError(event.message || t("comfyui.generateFailed"))
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
          setError(t("comfyui.progressDisconnected"))
        }
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [activeJobId, loadJobs])

  const handleCancel = async (job: ComfyJob) => {
    if (!window.confirm(t("comfyui.confirmCancel"))) return
    setActionBusy(`cancel-${job.id}`)
    try {
      await api(`/api/v1/comfyui/jobs/${job.id}/cancel`, { method: "POST" })
      abortRef.current?.abort()
      setActiveJobId(null)
      setGenerating(false)
      setProgress(null)
      setNotice(t("comfyui.taskCancelled"))
      await loadJobs()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const handleDeleteJob = async (job: ComfyJob) => {
    const withFiles = job.outputs.length > 0
    const message = withFiles
      ? t("comfyui.deleteJobWithOutputs")
      : t("comfyui.deleteJob")
    if (!window.confirm(message)) return
    setActionBusy(`delete-${job.id}`)
    try {
      await api(`/api/v1/comfyui/jobs/${job.id}?delete_outputs=true`, { method: "DELETE" })
      setNotice(t("comfyui.jobDeleted"))
      await loadJobs()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const handleDeleteOutput = async (job: ComfyJob, outputIndex: number) => {
    try {
      await api(`/api/v1/comfyui/jobs/${job.id}/outputs/${outputIndex}`, { method: "DELETE" })
      setNotice(t("comfyui.artifactDeleted"))
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
      setNotice(t("comfyui.artifactDeleted"))
      setSelectedArtifactKeys(current => {
        const next = new Set(current)
        next.delete(artifactKey(artifact))
        return next
      })
      const remainingOnPage = artifacts.length - 1
      const nextPage = remainingOnPage === 0 && artifactPage > 1 ? artifactPage - 1 : artifactPage
      if (nextPage !== artifactPage) setArtifactPage(nextPage)
      await loadArtifacts(nextPage)
      await loadJobs()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const artifactKey = (artifact: ComfyArtifact) => `${artifact.type ?? "output"}/${artifact.subfolder ?? ""}/${artifact.filename}`
  const selectedArtifacts = artifacts.filter(artifact => selectedArtifactKeys.has(artifactKey(artifact)))
  const allArtifactsSelected = artifacts.length > 0 && selectedArtifacts.length === artifacts.length

  const toggleArtifact = (artifact: ComfyArtifact, selected: boolean) => {
    setSelectedArtifactKeys(current => {
      const next = new Set(current)
      if (selected) next.add(artifactKey(artifact))
      else next.delete(artifactKey(artifact))
      return next
    })
  }

  const toggleAllArtifacts = () => {
    setSelectedArtifactKeys(current => {
      const next = new Set(current)
      if (allArtifactsSelected) artifacts.forEach(artifact => next.delete(artifactKey(artifact)))
      else artifacts.forEach(artifact => next.add(artifactKey(artifact)))
      return next
    })
  }

  const handleBatchDeleteArtifacts = async () => {
    if (!selectedArtifacts.length) return
    if (!window.confirm(t("comfyui.confirmBatchDelete"))) return
    setBatchDeleting(true)
    setError("")
    const results = await Promise.allSettled(selectedArtifacts.map(async artifact => {
      const query = new URLSearchParams({ filename: artifact.filename, subfolder: artifact.subfolder ?? "" })
      await api(`/api/v1/comfyui/artifacts?${query}`, { method: "DELETE" })
    }))
    const failed = results.filter(result => result.status === "rejected")
    setSelectedArtifactKeys(current => {
      const next = new Set(current)
      selectedArtifacts.forEach((artifact, index) => {
        if (results[index].status === "fulfilled") next.delete(artifactKey(artifact))
      })
      return next
    })
    const remainingOnPage = artifacts.length - (selectedArtifacts.length - failed.length)
    const nextPage = remainingOnPage === 0 && artifactPage > 1 ? artifactPage - 1 : artifactPage
    if (nextPage !== artifactPage) setArtifactPage(nextPage)
    await loadArtifacts(nextPage)
    await loadJobs()
    if (failed.length) setError(t("comfyui.deleteFailed"))
    else setNotice(t("comfyui.artifactsDeleted"))
    setBatchDeleting(false)
  }

  const galleryPages = Math.max(1, Math.ceil(artifactTotal / GALLERY_PAGE_SIZE))
  const changeGalleryPage = (nextPage: number) => {
    if (nextPage < 1 || nextPage > galleryPages || nextPage === artifactPage) return
    setArtifactPage(nextPage)
    setSelectedArtifactKeys(new Set())
    void loadArtifacts(nextPage)
  }

  const handleRerun = (job: ComfyJob) => {
    const target = templates.find(item => item.id === job.workflow_id)
    if (!target) {
      setError(t("comfyui.workflowRemoved"))
      return
    }
    setSelectedId(job.workflow_id)
    setParams({ ...defaultsOf(target), ...job.params })
    setNotice(t("comfyui.paramsLoaded"))
  }

  const handleRenameWorkflow = async () => {
    if (!template) return
    const currentName = template.filename?.split("/").pop()?.replace(/\.json$/i, "") ?? template.name
    const name = window.prompt(t("comfyui.workflowNamePrompt"), currentName)
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
      setNotice(t("comfyui.workflowRenamed"))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const handleDeleteWorkflow = async () => {
    if (!template) return
    if (!window.confirm(t("comfyui.confirmDeleteWorkflow"))) return
    setActionBusy("delete-workflow")
    setError("")
    try {
      await api(`/api/v1/comfyui/workflows/${template.id}`, { method: "DELETE" })
      setSelectedId("")
      await loadTemplates()
      setNotice(t("comfyui.workflowDeleted"))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const handleFreeMemory = async () => {
    setActionBusy("free")
    try {
      await api("/api/v1/comfyui/free", { method: "POST" })
      setNotice(t("comfyui.modelUnloaded"))
      window.setTimeout(loadStatus, 1000)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setActionBusy("") }
  }

  const visibleParams = template?.params.filter(param => showAdvanced || !param.advanced) ?? []
  const groupedParams = visibleParams.reduce<Record<string, ComfyParamDef[]>>((groups, param) => {
    const title = param.node_title || t("comfyui.workflowParams")
    ;(groups[title] ||= []).push(param)
    return groups
  }, {})
  const advancedCount = template?.params.filter(param => param.advanced).length ?? 0
  const progressPercent = progress?.max ? Math.round(progress.value / progress.max * 100) : 0
  const activeJob = jobs.find(job => job.id === activeJobId)
  const elapsedSeconds = activeJob?.created_at
    ? (clock - new Date(activeJob.created_at).getTime()) / 1000 : 0
  const phaseLabel = progress?.queuePosition
    ? t("comfyui.queuePosition")
    : progress?.nodeTitle || (progress?.node ? t("comfyui.node") : t("comfyui.waitingForComfyUI"))
  const stepLabel = progress?.max ? `${progress.value} / ${progress.max} · ${progressPercent}%` : t("comfyui.running")

  return (
    <div className="comfy-page">
      <header className="comfy-hero">
        <div>
          <div className="comfy-eyebrow">GENERATIVE WORKSPACE</div>
          <h1>{t("comfyui.title")}</h1>
          <p>{t("comfyui.subtitle")}</p>
        </div>
        <div className="comfy-hero-actions">
          <button className="comfy-secondary-btn" onClick={handleFreeMemory} disabled={actionBusy === "free" || Boolean(activeJobId)}>
            {actionBusy === "free" ? t("comfyui.freeing") : t("comfyui.freeVram")}
          </button>
          <button className="comfy-primary-btn" onClick={() => loadTemplates(true)} disabled={syncing}>
            {syncing ? t("comfyui.syncing") : t("comfyui.syncWorkflows")}
          </button>
        </div>
      </header>

      <div className="comfy-statusbar">
        <div className="comfy-status-main">
          <span className={`comfy-status-dot ${status?.online ? "comfy-online" : "comfy-offline"}`} />
          <strong>{status?.online ? t("comfyui.connected") : t("comfyui.disconnected")}</strong>
          {status?.comfyui_version && <span>v{status.comfyui_version}</span>}
        </div>
        {status?.devices?.map(device => (
          <div className="comfy-status-stat" key={device.name}>
            <span>{t("comfyui.gpuVram")}</span><strong>{fmtVram(device.vram_free)} / {fmtVram(device.vram_total)}</strong>
          </div>
        ))}
        <div className="comfy-status-stat"><span>{t("comfyui.running")}</span><strong>{status?.queue_running ?? 0}</strong></div>
        <div className="comfy-status-stat"><span>{t("comfyui.queued")}</span><strong>{status?.queue_pending ?? 0}</strong></div>
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
            <div><span className="comfy-section-kicker">LIBRARY</span><h2>{t("comfyui.workflows")}</h2></div>
            <span className="comfy-count">{templates.length}</span>
          </div>
          <div className="comfy-search-wrap">
            <span>⌕</span>
            <input value={workflowQuery} onChange={event => setWorkflowQuery(event.target.value)} placeholder={t("comfyui.searchWorkflows")} />
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
                  <span>{t("comfyui.nodeCount")}</span>
                  <span>{t("comfyui.paramCount")}</span>
                  <span>{item.runnable ? t("comfyui.runnable") : t("comfyui.needsWork")}</span>
                </div>
              </button>
            ))}
            {!filteredTemplates.length && <div className="comfy-empty-state">t("comfyui.noWorkflowFound")</div>}
          </div>
        </aside>

        <main className="comfy-editor-panel">
          {template ? (
            <>
              <div className="comfy-editor-header">
                <div>
                  <div className="comfy-editor-title-row"><span>{template.icon}</span><h2>{template.name}</h2></div>
                  <p>{template.filename} · {t("comfyui.updatedAt")} {fmtDate(template.updated_at)}</p>
                </div>
                <div className="comfy-editor-actions">
                  <button className="comfy-icon-btn" onClick={handleRenameWorkflow} disabled={Boolean(actionBusy)} title={t("comfyui.renameWorkflow")}>✎</button>
                  <button className="comfy-icon-btn comfy-icon-danger" onClick={handleDeleteWorkflow} disabled={Boolean(actionBusy)} title={t("comfyui.deleteWorkflow")}>⌫</button>
                  <span className={`comfy-ready-badge ${template.runnable ? "ready" : "blocked"}`}>
                    {template.runnable ? "READY" : "BLOCKED"}
                  </span>
                </div>
              </div>

              {!template.runnable ? (
                <div className="comfy-blocked-card">
                  <strong>{t("comfyui.workflowNotRunnable")}</strong>
                  <p>{template.disabled_reason}</p>
                  <span>{t("comfyui.workflowNotRunnableDesc")}</span>
                </div>
              ) : (
                <>
                  <div className="comfy-parameter-toolbar">
                    <div>
                      <strong>{t("comfyui.generateParams")}</strong>
                      <span>{t("comfyui.fieldCount")}</span>
                    </div>
                    {advancedCount > 0 && (
                      <button className={`comfy-text-btn ${showAdvanced ? "active" : ""}`} onClick={() => setShowAdvanced(value => !value)}>
                        {showAdvanced ? t("comfyui.hideAdvanced") : t("comfyui.showAdvanced")}
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
                    {!visibleParams.length && <div className="comfy-empty-state">t("comfyui.noAdjustableParams")</div>}
                  </div>
                  <div className="comfy-generate-dock">
                    <div><strong>{template.output_kind.toUpperCase()}</strong><span>{template.model || t("comfyui.useWorkflowModel")}</span></div>
                    <button className="comfy-generate-btn" onClick={handleGenerate}
                      disabled={generating || uploading || !status?.online}>
                      {uploading ? t("comfyui.uploading") : generating ? t("comfyui.generating") : t("comfyui.startGenerate")}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : <div className="comfy-empty-state">t("comfyui.noWorkflowsInDir")</div>}
        </main>

        <aside className="comfy-activity-panel">
          <div className="comfy-panel-heading">
            <div><span className="comfy-section-kicker">ACTIVITY</span><h2>{t("comfyui.jobs")}</h2></div>
            <button className="comfy-icon-btn" onClick={loadJobs} title={t("comfyui.refresh")}>↻</button>
          </div>

          {activeJobId && (
            <div className="comfy-progress-box">
              <div className="comfy-progress-head"><span>{t("comfyui.currentStage")}</span><strong>{stepLabel}</strong></div>
              <div className="comfy-progress-phase" title={phaseLabel}>{phaseLabel}</div>
              <div className="comfy-progress-track"><div className={`comfy-progress-fill ${!progress?.max ? "is-indeterminate" : ""}`}
                style={progress?.max ? { width: `${progressPercent}%` } : undefined} /></div>
              <div className="comfy-progress-metrics">
                <span>{t("comfyui.currentNodeProgress")}</span>
                <span>{t("comfyui.elapsed")} {fmtElapsed(elapsedSeconds)}</span>
              </div>
              <small>t("comfyui.stepNote")</small>
            </div>
          )}

          <div className="comfy-job-filters">
            {[['all', t('comfyui.all')], ['running', t('comfyui.generatingStatus')], ['done', t('comfyui.done')], ['error', t('comfyui.failed')]].map(([value, label]) => (
              <button key={value} className={jobFilter === value ? "active" : ""} onClick={() => setJobFilter(value)}>{label}</button>
            ))}
          </div>

          <div className="comfy-jobs">
            {filteredJobs.map(job => {
              const meta = STATUS_META(t)[job.status] ?? { label: job.status, cls: "" }
              const running = job.status === "queued" || job.status === "running"
              return (
                <article key={job.id} className={`comfy-job-item ${job.id === activeJobId ? "is-active" : ""}`}>
                  <div className="comfy-job-top">
                    <span className="comfy-job-name" title={job.workflow_name}>{job.workflow_name}</span>
                    <span className={`comfy-status-chip ${meta.cls}`}>{meta.label}</span>
                  </div>
                  <div className="comfy-job-date">{fmtDate(job.created_at)} · {t("comfyui.outputCount")}</div>
                  {job.error && <div className="comfy-job-error" title={job.error}>{job.error}</div>}
                  {running && job.current_node_title && (
                    <div className="comfy-job-progress">{job.current_node_title}{job.step_max ? ` · ${job.step_value ?? 0}/${job.step_max}` : ""}</div>
                  )}
                  <div className="comfy-job-actions">
                    {!running && <button onClick={() => handleRerun(job)}>{t("comfyui.rerun")}</button>}
                    {running && <button className="danger" disabled={actionBusy === `cancel-${job.id}`} onClick={() => handleCancel(job)}>{t("comfyui.cancel")}</button>}
                    {!running && <button className="danger" disabled={actionBusy === `delete-${job.id}`} onClick={() => handleDeleteJob(job)}>{t("comfyui.delete")}</button>}
                  </div>
                </article>
              )
            })}
            {!filteredJobs.length && <div className="comfy-empty-state">t("comfyui.noJobsInCategory")</div>}
          </div>
        </aside>
      </div>

      <section className="comfy-gallery-section">
        <div className="comfy-gallery-header">
          <div><span className="comfy-section-kicker">CREATIONS</span><h2>{t("comfyui.gallery")}</h2></div>
          <div className="comfy-gallery-heading-actions">
            <span>{t("comfyui.artifactTotal")}</span>
            {artifacts.length > 0 && <>
              <button className="comfy-secondary-btn comfy-select-all-btn" onClick={toggleAllArtifacts} disabled={batchDeleting}>{allArtifactsSelected ? t("comfyui.deselectAll") : t("comfyui.selectAll")}</button>
              {selectedArtifacts.length > 0 && <button className="comfy-delete-btn comfy-batch-delete-btn" onClick={handleBatchDeleteArtifacts} disabled={batchDeleting}>{batchDeleting ? t("comfyui.deleting") : t("comfyui.deleteSelected")}</button>}
            </>}
            <button className="comfy-icon-btn" onClick={() => loadArtifacts(artifactPage, true)} title={t("comfyui.rescanArtifacts")}>↻</button>
          </div>
        </div>
        {artifacts.length ? (
          <div className="comfy-gallery">
            {artifacts.map(artifact => (
              <ComfyOutputCard key={`${artifact.subfolder ?? ""}/${artifact.filename}`} output={artifact}
                onDelete={() => handleDeleteArtifact(artifact)} selected={selectedArtifactKeys.has(artifactKey(artifact))}
                onSelectedChange={selected => toggleArtifact(artifact, selected)} batchDeleting={batchDeleting} />
            ))}
          </div>
        ) : <div className="comfy-gallery-empty"><span>✦</span><strong>{t("comfyui.noArtifactsYet")}</strong><p>{t("comfyui.artifactsWillAppear")}</p></div>}
        {artifactTotal > GALLERY_PAGE_SIZE && (
          <nav className="comfy-gallery-pagination" aria-label={t("comfyui.galleryPagination")}>
            <button className="comfy-secondary-btn" onClick={() => changeGalleryPage(artifactPage - 1)} disabled={artifactPage === 1}>{t("comfyui.prevPage")}</button>
            <span>{t("comfyui.pageOf", { page: artifactPage, pages: galleryPages })}</span>
            <button className="comfy-secondary-btn" onClick={() => changeGalleryPage(artifactPage + 1)} disabled={artifactPage === galleryPages}>{t("comfyui.nextPage")}</button>
          </nav>
        )}
      </section>
    </div>
  )
}
