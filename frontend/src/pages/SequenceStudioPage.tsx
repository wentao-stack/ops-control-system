import { useCallback, useEffect, useMemo, useState } from "react"
import { api, getToken } from "../auth"
import { useTranslation } from "react-i18next"
import i18n from "../i18n"
import type { ComfyOutputItem, ComfySequence } from "../types"

type ReferenceKey = "first_frame" | "character_ref" | "background_ref"

const REFERENCE_META: Record<ReferenceKey, { icon: string; titleKey: string; hintKey: string }> = {
  first_frame: { icon: "▶", titleKey: "sequence.firstFrameTitle", hintKey: "sequence.firstFrameHint" },
  character_ref: { icon: "◉", titleKey: "sequence.characterRefTitle", hintKey: "sequence.characterRefHint" },
  background_ref: { icon: "▧", titleKey: "sequence.backgroundRefTitle", hintKey: "sequence.backgroundRefHint" },
}

const STATUS_KEYS: Record<string, string> = {
  queued: "sequence.statusQueued",
  running: "sequence.statusRunning",
  stitching: "sequence.statusStitching",
  done: "sequence.statusDone",
  error: "sequence.statusError",
  cancelled: "sequence.statusCancelled",
}

const SCRIPT_EXAMPLE_KEY = "sequence.scriptExample"

const UPLOAD_TARGET_BYTES = 900 * 1024
const MAX_REFERENCE_EDGE = 1920

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("圖片壓縮失敗")), "image/webp", quality)
  })
}

async function prepareReferenceImage(file: File): Promise<File> {
  if (file.size <= UPLOAD_TARGET_BYTES && ["image/jpeg", "image/webp"].includes(file.type)) return file

  const objectUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = objectUrl
    await image.decode()
    const sourceWidth = image.naturalWidth
    const sourceHeight = image.naturalHeight
    if (!sourceWidth || !sourceHeight) throw new Error(`無法讀取圖片「${file.name}」`)

    let scale = Math.min(1, MAX_REFERENCE_EDGE / Math.max(sourceWidth, sourceHeight))
    let quality = 0.9
    let blob: Blob | null = null

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(sourceWidth * scale))
      canvas.height = Math.max(1, Math.round(sourceHeight * scale))
      const context = canvas.getContext("2d")
      if (!context) throw new Error("瀏覽器不支援圖片壓縮")
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = "high"
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      blob = await canvasBlob(canvas, quality)
      if (blob.size <= UPLOAD_TARGET_BYTES) break
      if (quality > 0.58) quality -= 0.08
      else scale *= 0.82
    }
    if (!blob || blob.size > UPLOAD_TARGET_BYTES) throw new Error(`圖片「${file.name}」壓縮後仍然過大`)
    const stem = file.name.replace(/\.[^.]+$/, "") || "reference"
    return new File([blob], `${stem}.webp`, { type: "image/webp", lastModified: Date.now() })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function timelineLines(prompt: string): Array<{ time: string; action: string }> {
  const result: Array<{ time: string; action: string }> = []
  const range = /^\s*[\[【(（]?\s*((?:\d{1,3}:)?\d{1,2}(?:\.\d+)?)\s*(?:s|秒)?\s*(?:-|~|～|—|–|至|到)\s*((?:\d{1,3}:)?\d{1,2}(?:\.\d+)?)\s*(?:s|秒)?\s*[\]】)）]?\s*[:：]?\s*(.+)$/i
  const point = /^\s*[\[【(（]?\s*((?:\d{1,3}:)?\d{1,2}(?:\.\d+)?)\s*(?:s|秒)?\s*[\]】)）]?\s*[:：]\s*(.+)$/i
  for (const line of prompt.split("\n")) {
    const rangeMatch = line.match(range)
    if (rangeMatch) {
      result.push({ time: `${rangeMatch[1]}–${rangeMatch[2]}s`, action: rangeMatch[3] })
      continue
    }
    const pointMatch = line.match(point)
    if (pointMatch) result.push({ time: `${pointMatch[1]}s`, action: pointMatch[2] })
  }
  return result
}

async function uploadImage(file: File): Promise<string> {
  const prepared = await prepareReferenceImage(file)
  const data = new FormData()
  data.append("file", prepared)
  const result = await api<{ filename: string; subfolder?: string }>("/api/v1/comfyui/upload", {
    method: "POST",
    body: data,
  })
  return result.subfolder ? `${result.subfolder}/${result.filename}` : result.filename
}

async function loadMedia(output: ComfyOutputItem): Promise<string> {
  const query = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder ?? "",
    view_type: output.type ?? "output",
  })
  const token = getToken()
  const response = await fetch(`/api/v1/comfyui/view?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error("影片讀取失敗")
  return URL.createObjectURL(await response.blob())
}

function ReferenceCard({
  kind,
  file,
  disabled,
  onChange,
}: {
  kind: ReferenceKey
  file: File | null
  disabled: boolean
  onChange: (file: File | null) => void
}) {
  const { t } = useTranslation()
  const meta = REFERENCE_META[kind]
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  return (
    <label className={`sequence-ref-card ${preview ? "has-image" : ""}`}>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled}
        onChange={event => onChange(event.target.files?.[0] ?? null)}
      />
      {preview ? <img src={preview} alt={t(meta.titleKey)} /> : <span className="sequence-ref-icon">{meta.icon}</span>}
      <span className="sequence-ref-overlay">
        <strong>{t(meta.titleKey)}</strong>
        <small>{file?.name ?? t(meta.hintKey)}</small>
      </span>
      {preview && <span className="sequence-ref-change">t("sequence.changeImage")</span>}
    </label>
  )
}

function ResultPlayer({ output }: { output: ComfyOutputItem }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    loadMedia(output).then(next => {
      objectUrl = next
      if (active) setUrl(next)
    }).catch(() => {})
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [output])
  if (!url) return <div className="sequence-player-loading">t("sequence.loadingResult")</div>
  return (
    <div className="sequence-player">
      <video src={url} controls preload="metadata" />
      <a className="btn btn-primary btn-sm" href={url} download={output.filename}>t("sequence.downloadResult")</a>
    </div>
  )
}

export function SequenceStudioPage() {
  const { t } = useTranslation()

  const [files, setFiles] = useState<Record<ReferenceKey, File | null>>({
    first_frame: null,
    character_ref: null,
    background_ref: null,
  })
  const [title, setTitle] = useState(t("sequence.defaultTitle"))
  const [prompt, setPrompt] = useState("")
  const [totalSeconds, setTotalSeconds] = useState(30)
  const [segmentSeconds, setSegmentSeconds] = useState(10)
  const [seed, setSeed] = useState(-1)
  const [sequences, setSequences] = useState<ComfySequence[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = sequences.find(item => item.id === selectedId) ?? sequences[0]
  const segments = Math.ceil(totalSeconds / segmentSeconds)
  const parsedTimeline = useMemo(() => timelineLines(prompt), [prompt])
  const hasActive = sequences.some(item => ["queued", "running", "stitching"].includes(item.status))

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ sequences: ComfySequence[] }>("/api/v1/comfyui/sequences?limit=30")
      setSequences(result.sequences)
      setSelectedId(current => current ?? result.sequences[0]?.id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sequence.fetchTaskFailed"))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (!hasActive) return
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [hasActive, refresh])

  const ready = useMemo(
    () => Object.values(files).every(Boolean) && prompt.trim().length > 0 && !submitting,
    [files, prompt, submitting],
  )

  const createSequence = async () => {
    if (!ready) return
    setSubmitting(true)
    setError(null)
    try {
      const [firstFrame, characterRef, backgroundRef] = await Promise.all([
        uploadImage(files.first_frame!),
        uploadImage(files.character_ref!),
        uploadImage(files.background_ref!),
      ])
      const sequence = await api<ComfySequence>("/api/v1/comfyui/sequences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          prompt,
          first_frame: firstFrame,
          character_ref: characterRef,
          background_ref: backgroundRef,
          total_seconds: totalSeconds,
          segment_seconds: segmentSeconds,
          width: 864,
          height: 480,
          seed,
        }),
      })
      setSequences(current => [sequence, ...current])
      setSelectedId(sequence.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sequence.createTaskFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = async (id: string) => {
    if (!window.confirm(t("sequence.confirmCancel"))) return
    try {
      await api(`/api/v1/comfyui/sequences/${id}/cancel`, { method: "POST" })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sequence.cancelFailed"))
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm(t("sequence.confirmDelete"))) return
    try {
      await api(`/api/v1/comfyui/sequences/${id}`, { method: "DELETE" })
      setSelectedId(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sequence.deleteFailed"))
    }
  }

  return (
    <div className="sequence-studio">
      <section className="sequence-hero">
        <div>
          <span className="sequence-eyebrow">CONTINUITY STUDIO</span>
          <h1>{t("sequence.title")}</h1>
          <p>{t("sequence.subtitle")}</p>
        </div>
        <div className="sequence-flow-mini">
          <span>{t("sequence.firstFrame")}</span><b>→</b><span>{t("sequence.generate")}</span><b>→</b><span>{t("sequence.lastFrameRelay")}</span><b>→</b><span>{t("sequence.merge")}</span>
        </div>
      </section>

      {error && <div className="sequence-alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

      <div className="sequence-grid">
        <section className="sequence-creator">
          <div className="sequence-section-head">
            <div><span>01</span><h2>{t("sequence.lockVisualRef")}</h2></div>
            <small>t("sequence.refHint")</small>
          </div>
          <div className="sequence-reference-grid">
            {(Object.keys(REFERENCE_META) as ReferenceKey[]).map(kind => (
              <ReferenceCard
                key={kind}
                kind={kind}
                file={files[kind]}
                disabled={submitting}
                onChange={file => setFiles(current => ({ ...current, [kind]: file }))}
              />
            ))}
          </div>

          <div className="sequence-section-head sequence-step-two">
            <div><span>02</span><h2>{t("sequence.setAnimationScript")}</h2></div>
          </div>
          <div className="sequence-fields">
            <label className="sequence-field sequence-field-title">
              <span>{t("sequence.workTitle")}</span>
              <input value={title} maxLength={200} onChange={event => setTitle(event.target.value)} />
            </label>
            <label className="sequence-field sequence-field-prompt">
              <span>{t("sequence.timelinePrompt")}</span>
              <textarea
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                placeholder={t(SCRIPT_EXAMPLE_KEY)}
                rows={6}
              />
              <div className="sequence-prompt-guide">
                <span>t("sequence.promptGuide")</span>
                <button type="button" onClick={() => setPrompt(t(SCRIPT_EXAMPLE_KEY))}>{t("sequence.insertExample")}</button>
              </div>
            </label>
            {parsedTimeline.length > 0 && (
              <div className="sequence-script-preview">
                <div className="sequence-script-preview-head"><strong>{t("sequence.parsedActions")} {parsedTimeline.length}</strong><span>{t("sequence.autoDistribute")} {segments}</span></div>
                <div>
                  {parsedTimeline.map((cue, index) => <span key={`${cue.time}-${index}`}><b>{cue.time}</b><em>{cue.action}</em></span>)}
                </div>
              </div>
            )}
            <div className="sequence-settings-row">
              <label className="sequence-field">
                <span>{t("sequence.duration")}</span>
                <div className="sequence-input-unit">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={5}
                    max={300}
                    step={1}
                    value={totalSeconds}
                    onKeyDown={event => [".", "e", "E", "+", "-"].includes(event.key) && event.preventDefault()}
                    onChange={event => setTotalSeconds(Math.max(5, Math.min(300, Math.trunc(Number(event.target.value) || 5))))}
                  />
                  <b>{t("sequence.seconds")}</b>
                </div>
                <small>t("sequence.durationHint")</small>
              </label>
              <div className="sequence-field">
                <span>{t("sequence.strategy")}</span>
                <div className="sequence-strategy-options" role="group" aria-label={t("sequence.segmentDuration")}>
                  {[5, 10, 15].map(seconds => (
                    <button
                      key={seconds}
                      type="button"
                      className={segmentSeconds === seconds ? "active" : ""}
                      onClick={() => setSegmentSeconds(seconds)}
                    >
                      <strong>{seconds}s</strong>
                      <small>{seconds === 5 ? t("sequence.mostStable") : seconds === 10 ? t("sequence.balanced") : t("sequence.fewestSegments")}</small>
                    </button>
                  ))}
                </div>
                <small>t("sequence.strategyHint")</small>
              </div>
              <label className="sequence-field">
                <span>{t("sequence.seed")}</span>
                <input type="number" value={seed} onChange={event => setSeed(Number(event.target.value))} />
                <small>t("sequence.seedHint")</small>
              </label>
            </div>
            <div className="sequence-duration-presets">
              <span>{t("sequence.quickSelect")}</span>
              {[15, 30, 60, 120].map(seconds => <button key={seconds} type="button" className={totalSeconds === seconds ? "active" : ""} onClick={() => setTotalSeconds(seconds)}>{seconds} {t("sequence.sec")}</button>)}
            </div>
          </div>

          <div className="sequence-submit-bar">
            <div><strong>{segments}</strong><span>{t("sequence.segmentInfo")}</span></div>
            <button className="btn btn-primary sequence-generate" disabled={!ready} onClick={createSequence}>
              {submitting ? t("sequence.submitting") : t("sequence.startGenerate")}
            </button>
          </div>
        </section>

        <aside className="sequence-monitor">
          <div className="sequence-monitor-head">
            <div><span>LIVE QUEUE</span><h2>{t("sequence.productionProgress")}</h2></div>
            <button className="comfy-icon-btn" onClick={refresh} title={t("sequence.refresh")}>↻</button>
          </div>

          {selected ? (
            <div className="sequence-active">
              <div className="sequence-active-title">
                <div><strong>{selected.title}</strong><small>{new Date(selected.created_at).toLocaleString("zh-TW")}</small></div>
                <span className={`sequence-status is-${selected.status}`}>{t(STATUS_KEYS[selected.status] ?? selected.status)}</span>
              </div>
              {selected.final_output ? (
                <ResultPlayer output={selected.final_output} />
              ) : (
                <div className="sequence-progress-stage">
                  <div className="sequence-progress-ring" style={{ "--value": `${selected.progress * 3.6}deg` } as React.CSSProperties}>
                    <span>{selected.progress}%</span>
                  </div>
                  <div>
                    <strong>{selected.status === "stitching" ? t("sequence.mergingAll") : t("sequence.generatingSegment", { current: Math.max(1, selected.current_segment), total: selected.total_segments })}</strong>
                    <small>t("sequence.segmentNote")</small>
                  </div>
                </div>
              )}

              <div className="sequence-timeline">
                {Array.from({ length: selected.total_segments }, (_, index) => {
                  const number = index + 1
                  const done = selected.segments.some(segment => segment.index === number)
                  const current = selected.current_segment === number && selected.status === "running"
                  return <div key={number} className={`${done ? "done" : ""} ${current ? "current" : ""}`}><i>{done ? "✓" : number}</i><span>{t("sequence.segment", { number })}</span></div>
                })}
                <div className={selected.status === "done" ? "done" : selected.status === "stitching" ? "current" : ""}><i>{selected.status === "done" ? "✓" : "∞"}</i><span>{t("sequence.finalVideo")}</span></div>
              </div>
              {selected.error && <div className="sequence-job-error">{selected.error}</div>}
              <div className="sequence-job-actions">
                {["queued", "running", "stitching"].includes(selected.status) && <button className="btn btn-sm" onClick={() => cancel(selected.id)}>t("sequence.cancelTask")</button>}
                {!(["queued", "running", "stitching"].includes(selected.status)) && <button className="btn btn-sm btn-danger" onClick={() => remove(selected.id)}>t("sequence.deleteTaskAndOutputs")</button>}
              </div>
            </div>
          ) : <div className="sequence-empty"><span>◇</span><strong>{t("sequence.noLongAnimationTask")}</strong><small>{t("sequence.noTaskHint")}</small></div>}

          {sequences.length > 1 && (
            <div className="sequence-history">
              <h3>{t("sequence.recentTasks")}</h3>
              {sequences.map(item => (
                <button key={item.id} className={item.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
                  <span><strong>{item.title}</strong><small>{item.total_seconds}s · {t("sequence.totalSegments")} {item.total_segments}</small></span>
                  <em>{t(STATUS_KEYS[item.status] ?? item.status)}</em>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}