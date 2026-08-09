import { useCallback, useEffect, useRef, useState } from "react"
import { api, getToken } from "../auth"
import type {
  ComfyGenerateResponse,
  ComfyJob,
  ComfyOutputItem,
  ComfyParamDef,
  ComfyStatus,
  ComfyWorkflowTemplate,
} from "../types"

// ── helpers ──────────────────────────────────────────────────────────────

const fmtVram = (bytes?: number) => {
  if (!bytes) return "?"
  return (bytes / 1024 ** 3).toFixed(1) + "G"
}

const defaultsOf = (t: ComfyWorkflowTemplate): Record<string, unknown> => {
  const d: Record<string, unknown> = {}
  for (const p of t.params) {
    if (p.default != null) d[p.key] = p.default
    else if (p.type === "slider" || p.type === "number") d[p.key] = p.min ?? 0
    else if (p.type === "seed") d[p.key] = -1
    else if (p.type === "select") d[p.key] = p.options?.[0] ?? ""
    else d[p.key] = ""
  }
  return d
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  queued: { label: "排隊中", cls: "comfy-st-queued" },
  running: { label: "生成中", cls: "comfy-st-running" },
  done: { label: "完成", cls: "comfy-st-done" },
  error: { label: "失敗", cls: "comfy-st-error" },
  cancelled: { label: "已取消", cls: "comfy-st-error" },
}

// 帶 JWT 的媒體抓取 → object URL
async function fetchMediaUrl(o: ComfyOutputItem): Promise<string | null> {
  const token = getToken()
  const qs = new URLSearchParams({
    filename: o.filename,
    subfolder: o.subfolder ?? "",
    type: o.type ?? "output",
  })
  try {
    const resp = await fetch(`/api/v1/comfyui/view?${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!resp.ok) return null
    const blob = await resp.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

// ── 單一輸出卡片 ──────────────────────────────────────────────────────────

function ComfyOutputCard({ output }: { output: ComfyOutputItem }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    fetchMediaUrl(output).then(u => {
      if (!alive) return
      if (u) setUrl(u)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [output])

  if (failed) {
    return <div className="comfy-output-card comfy-output-failed">❌ 無法載入</div>
  }
  if (!url) {
    return <div className="comfy-output-card comfy-output-loading">載入中…</div>
  }
  return (
    <div className="comfy-output-card">
      {output.kind === "image" ? (
        <img src={url} alt={output.filename} loading="lazy" />
      ) : output.kind === "video" || output.kind === "gif" ? (
        <video src={url} controls preload="metadata" />
      ) : (
        <audio src={url} controls />
      )}
      <div className="comfy-output-actions">
        <a className="btn btn-sm" href={url} download={output.filename}>⬇ 下載</a>
        <span className="comfy-output-name" title={output.filename}>{output.filename}</span>
      </div>
    </div>
  )
}

// ── 參數輸入 ──────────────────────────────────────────────────────────────

function ParamInput({
  def,
  value,
  onChange,
  disabled,
}: {
  def: ComfyParamDef
  value: unknown
  onChange: (v: unknown) => void
  disabled: boolean
}) {
  const [preview, setPreview] = useState<string>("")

  const handleFile = (file: File | undefined) => {
    if (!file) return
    onChange({ __upload: true, file, name: file.name })
  }

  const render = () => {
    switch (def.type) {
      case "textarea":
        return (
          <textarea
            className="comfy-input comfy-textarea"
            placeholder={def.placeholder ?? ""}
            rows={def.key === "prompt" ? 5 : 3}
            value={String(value ?? "")}
            disabled={disabled}
            onChange={e => onChange(e.target.value)}
          />
        )
      case "text":
        return (
          <input
            className="comfy-input"
            type="text"
            placeholder={def.placeholder ?? ""}
            value={String(value ?? "")}
            disabled={disabled}
            onChange={e => onChange(e.target.value)}
          />
        )
      case "number":
        return (
          <input
            className="comfy-input comfy-number"
            type="number"
            value={value == null ? "" : String(value)}
            disabled={disabled}
            onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          />
        )
      case "slider": {
        const v = Number(value ?? def.min ?? 0)
        return (
          <div className="comfy-slider-row">
            <input
              type="range"
              min={def.min}
              max={def.max}
              step={def.step}
              value={v}
              disabled={disabled}
              onChange={e => onChange(Number(e.target.value))}
            />
            <span className="comfy-slider-value">{v}{def.unit ?? ""}</span>
          </div>
        )
      }
      case "select":
        return (
          <select
            className="comfy-input"
            value={String(value ?? "")}
            disabled={disabled}
            onChange={e => onChange(e.target.value)}
          >
            {(def.options ?? []).map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        )
      case "seed":
        return (
          <div className="comfy-seed-row">
            <input
              className="comfy-input comfy-number"
              type="number"
              value={value == null ? "" : String(value)}
              disabled={disabled}
              onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))}
            />
            <button
              className="btn btn-sm"
              disabled={disabled}
              onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))}
              title="隨機種子"
            >🎲 隨機</button>
          </div>
        )
      case "image":
        return (
          <div className="comfy-image-upload">
            {preview ? (
              <img className="comfy-image-preview" src={preview} alt="preview" />
            ) : value ? (
              <div className="comfy-image-current">🖼 {String(value)}</div>
            ) : null}
            <label className="btn btn-sm comfy-upload-btn">
              {preview ? "更換圖片" : "⬆ 上傳圖片"}
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                disabled={disabled}
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) {
                    setPreview(URL.createObjectURL(f))
                    handleFile(f)
                  }
                }}
              />
            </label>
            {preview && (
              <button
                className="btn btn-sm"
                disabled={disabled}
                onClick={() => {
                  setPreview("")
                  onChange("")
                }}
              >✕ 移除</button>
            )}
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div className="comfy-param">
      <label className="comfy-param-label">
        {def.label}
        {def.required && <span className="comfy-required"> *</span>}
      </label>
      {render()}
      {def.help && <div className="comfy-param-help">{def.help}</div>}
    </div>
  )
}

// ── 主頁面 ────────────────────────────────────────────────────────────────

export function ComfyUIPage() {
  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [templates, setTemplates] = useState<ComfyWorkflowTemplate[]>([])
  const [selectedId, setSelectedId] = useState<string>("")
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [pendingUploads, setPendingUploads] = useState<Record<string, { file: File; name: string }>>({})
  const [uploading, setUploading] = useState(false)
  const [jobs, setJobs] = useState<ComfyJob[]>([])
  const [generating, setGenerating] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ value: number; max: number } | null>(null)
  const [error, setError] = useState<string>("")
  const abortRef = useRef<AbortController | null>(null)

  const template = templates.find(t => t.id === selectedId) ?? templates[0] ?? null

  // ── 載入 ──
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<ComfyStatus>("/api/v1/comfyui/status"))
    } catch {
      /* ComfyUI 離線時 status 也應回傳 online:false，此處失敗僅略過 */
    }
  }, [])

  const loadTemplates = useCallback(async () => {
    try {
      const r = await api<{ templates: ComfyWorkflowTemplate[] }>("/api/v1/comfyui/workflows")
      setTemplates(r.templates)
      setSelectedId(prev => (prev && r.templates.some(t => t.id === prev) ? prev : r.templates[0]?.id ?? ""))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadJobs = useCallback(async () => {
    try {
      const r = await api<{ jobs: ComfyJob[] }>("/api/v1/comfyui/jobs?limit=20")
      setJobs(r.jobs)
    } catch {
      /* 略過 */
    }
  }, [])

  useEffect(() => {
    loadStatus()
    loadTemplates()
    loadJobs()
    const t = setInterval(loadStatus, 15000)
    return () => clearInterval(t)
  }, [loadStatus, loadTemplates, loadJobs])

  // 切換模板 → 重置參數為預設
  useEffect(() => {
    if (template) setParams(defaultsOf(template))
  }, [template?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 掛載時若有未完成任務 → 重連進度
  useEffect(() => {
    if (jobs.length) {
      const running = jobs.find(j => j.status === "queued" || j.status === "running")
      if (running) setActiveJobId(running.id)
    }
  }, [jobs])

  // ── 上傳圖片（延遲到 generate 前統一送出） ──
  const handleGenerate = async () => {
    const t = template
    if (!t || generating) return
    setError("")

    // 上傳待處理圖片
    let finalParams = { ...params }
    for (const [key, up] of Object.entries(pendingUploads)) {
      setUploading(true)
      try {
        const fd = new FormData()
        fd.append("file", up.file)
        const r = await api<{ filename: string; subfolder: string; type: string }>("/api/v1/comfyui/upload", {
          method: "POST",
          body: fd,
        })
        finalParams = { ...finalParams, [key]: r.filename }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setUploading(false)
        return
      }
    }
    setUploading(false)
    setPendingUploads({})

    // 必填檢查
    for (const p of t.params) {
      const v = finalParams[p.key]
      if (p.required && (v === undefined || v === null || v === "")) {
        setError(`請填寫「${p.label}」`)
        return
      }
    }

    setGenerating(true)
    setProgress(null)
    try {
      const r = await api<ComfyGenerateResponse>("/api/v1/comfyui/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: t.id, params: finalParams }),
      })
      setActiveJobId(r.job_id)
      await loadJobs()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setGenerating(false)
    }
  }

  // ── SSE 進度串流 ──
  useEffect(() => {
    if (!activeJobId) return
    let cancelled = false
    const ctrl = new AbortController()
    abortRef.current = ctrl

    ;(async () => {
      try {
        const resp = await api<Response>(`/api/v1/comfyui/jobs/${activeJobId}/events`, { signal: ctrl.signal })
        const reader = resp.body!.getReader()
        const dec = new TextDecoder()
        let buf = ""
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue
              try {
                const ev = JSON.parse(line.slice(6))
                if (ev.event === "progress") {
                  setProgress({ value: ev.value, max: ev.max })
                } else if (ev.event === "done" || ev.event === "error") {
                  setProgress(ev.event === "done" ? { value: 100, max: 100 } : null)
                  setGenerating(false)
                  setActiveJobId(null)
                  if (ev.event === "error" && ev.message) setError(ev.message)
                  await loadJobs()
                }
              } catch {
                /* 忽略壞事件 */
              }
            }
          }
        }
      } catch (e) {
        if (!cancelled) {
          setGenerating(false)
          setActiveJobId(null)
          setError("進度連線失敗，請重新整理頁面")
        }
      }
    })()

    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [activeJobId, loadJobs])

  // ── 重跑 ──
  const handleRerun = (job: ComfyJob) => {
    if (generating) return
    setSelectedId(job.workflow_id)
    setParams(job.params)
    setError("")
  }

  const doneJobs = jobs.filter(j => j.outputs.length > 0)

  return (
    <div className="comfy-page">
      {/* 狀態列 */}
      <div className="comfy-statusbar">
        <div className={`comfy-status-dot ${status?.online ? "comfy-online" : "comfy-offline"}`} />
        <span>{status?.online ? `ComfyUI 連線中` : "ComfyUI 離線"}</span>
        {status?.comfyui_version && <span className="comfy-status-muted">v{status.comfyui_version}</span>}
        {status?.devices?.map(d => (
          <span key={d.name} className="comfy-status-muted">
            {d.name}: {fmtVram(d.vram_free)}/{fmtVram(d.vram_total)} 可用
          </span>
        ))}
        <span className="comfy-status-muted">
          佇列 {status?.queue_running ?? 0} 執行中 / {status?.queue_pending ?? 0} 排隊
        </span>
        <button className="btn btn-sm" onClick={loadStatus}>↻</button>
      </div>

      <div className="comfy-body">
        {/* 左：工作流選擇 */}
        <aside className="comfy-templates">
          <h3 className="comfy-panel-title">工作流</h3>
          {templates.map(t => (
            <button
              key={t.id}
              className={`comfy-template-card ${t.id === template?.id ? "comfy-template-active" : ""}`}
              onClick={() => setSelectedId(t.id)}
            >
              <div className="comfy-template-head">
                <span className="comfy-template-icon">{t.icon ?? "🎨"}</span>
                <span className="comfy-template-name">{t.name}</span>
              </div>
              {t.model && <div className="comfy-template-meta">🧠 {t.model}</div>}
              {t.estimated_time && <div className="comfy-template-meta">⏱ {t.estimated_time}</div>}
            </button>
          ))}
          {templates.length === 0 && <div className="comfy-empty">沒有可用工作流</div>}
        </aside>

        {/* 中：參數表單 */}
        <section className="comfy-form">
          {template ? (
            <>
              <h3 className="comfy-form-title">
                {template.icon ?? "🎨"} {template.name}
              </h3>
              {template.description && <p className="comfy-form-desc">{template.description}</p>}
              <div className="comfy-form-fields">
                {template.params.map(p => (
                  <ParamInput
                    key={p.key}
                    def={p}
                    value={params[p.key]}
                    disabled={generating || uploading}
                    onChange={v => setParams(prev => ({ ...prev, [p.key]: v }))}
                  />
                ))}
              </div>
              {error && <div className="comfy-error">{error}</div>}
              <button
                className="comfy-generate-btn"
                onClick={handleGenerate}
                disabled={generating || uploading || !status?.online}
              >
                {uploading ? "上傳中…" : generating ? "⏳ 生成中…" : "⚡ 生成"}
              </button>
              {!status?.online && <div className="comfy-error">ComfyUI 未連線，無法生成</div>}
            </>
          ) : (
            <div className="comfy-empty">請選擇一個工作流</div>
          )}
        </section>

        {/* 右：進度 + 歷史 + 畫廊 */}
        <section className="comfy-panel">
          <h3 className="comfy-panel-title">生成歷史</h3>

          {activeJobId && (
            <div className="comfy-progress-box">
              <div className="comfy-progress-label">
                正在生成…
                {progress?.max ? ` ${Math.round((progress.value / progress.max) * 100)}%` : ""}
              </div>
              {progress?.max ? (
                <div className="comfy-progress-track">
                  <div
                    className="comfy-progress-fill"
                    style={{ width: `${Math.round((progress.value / progress.max) * 100)}%` }}
                  />
                </div>
              ) : (
                <div className="comfy-progress-track"><div className="comfy-progress-fill comfy-progress-indeterminate" /></div>
              )}
            </div>
          )}

          <div className="comfy-jobs">
            {jobs.map(j => {
              const sm = STATUS_META[j.status] ?? { label: j.status, cls: "" }
              return (
                <div key={j.id} className={`comfy-job-item ${j.id === activeJobId ? "comfy-job-active" : ""}`}>
                  <div className="comfy-job-line">
                    <span className="comfy-job-icon">{j.outputs.length ? "✅" : j.status === "error" ? "❌" : "⏳"}</span>
                    <span className="comfy-job-name" title={j.workflow_name}>{j.workflow_name}</span>
                    <span className={`comfy-status-chip ${sm.cls}`}>{sm.label}</span>
                  </div>
                  <div className="comfy-job-line comfy-job-sub">
                    <span>{new Date(j.created_at ?? Date.now()).toLocaleString("zh-TW")}</span>
                    {j.status === "done" && (
                      <button className="btn btn-sm" onClick={() => handleRerun(j)}>↻ 重跑</button>
                    )}
                    {j.status === "error" && j.error && <span className="comfy-job-err" title={j.error}>{j.error.slice(0, 40)}</span>}
                  </div>
                </div>
              )
            })}
            {jobs.length === 0 && <div className="comfy-empty">還沒有生成任務</div>}
          </div>

          {doneJobs.length > 0 && (
            <>
              <h3 className="comfy-panel-title comfy-gallery-title">結果畫廊</h3>
              <div className="comfy-gallery">
                {doneJobs.map(j =>
                  j.outputs.map(o => <ComfyOutputCard key={`${j.id}-${o.filename}`} output={o} />)
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
