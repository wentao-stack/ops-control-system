import { useCallback, useEffect, useMemo, useState } from "react"
import { api, getToken } from "../auth"
import { useTranslation } from "react-i18next"
import type { ComfyOutputItem, ComfySequence } from "../types"

type ReferenceKey = "first_frame" | "character_ref" | "background_ref"

const REFERENCE_META: Record<ReferenceKey, { icon: string; title: string; hint: string }> = {
  first_frame: { icon: "▶", title: "首幀圖片", hint: "動畫開始的精確畫面" },
  character_ref: { icon: "◉", title: "人物參考", hint: "固定臉部、服裝與體型" },
  background_ref: { icon: "▧", title: "背景參考", hint: "固定場景、構圖與光線" },
}

const STATUS: Record<string, string> = {
  queued: "等待生成",
  running: "分段生成中",
  stitching: "正在合併影片",
  done: "生成完成",
  error: "生成失敗",
  cancelled: "已取消",
}

const SCRIPT_EXAMPLE = `全程保持人物、服裝、背景和鏡頭方向一致
0-5秒：人物從椅子上緩慢起身
5-10秒：人物走向窗邊，鏡頭平穩跟隨
10-15秒：人物停下並轉身微笑`

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
      {preview ? <img src={preview} alt={meta.title} /> : <span className="sequence-ref-icon">{meta.icon}</span>}
      <span className="sequence-ref-overlay">
        <strong>{meta.title}</strong>
        <small>{file?.name ?? meta.hint}</small>
      </span>
      {preview && <span className="sequence-ref-change">更換</span>}
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
  if (!url) return <div className="sequence-player-loading">正在載入成品…</div>
  return (
    <div className="sequence-player">
      <video src={url} controls preload="metadata" />
      <a className="btn btn-primary btn-sm" href={url} download={output.filename}>下載成品</a>
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
  const [title, setTitle] = useState("連續動畫")
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
      setError(err instanceof Error ? err.message : "讀取任務失敗")
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
      setError(err instanceof Error ? err.message : "建立任務失敗")
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = async (id: string) => {
    if (!window.confirm("確定取消這個長動畫任務？目前分段會停止。")) return
    try {
      await api(`/api/v1/comfyui/sequences/${id}/cancel`, { method: "POST" })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消失敗")
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm("確定永久刪除任務、所有分段與合併成品？")) return
    try {
      await api(`/api/v1/comfyui/sequences/${id}`, { method: "DELETE" })
      setSelectedId(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除失敗")
    }
  }

  return (
    <div className="sequence-studio">
      <section className="sequence-hero">
        <div>
          <span className="sequence-eyebrow">CONTINUITY STUDIO</span>
          <h1>動畫連續生成</h1>
          <p>提供三張參考圖與生成時長，人物、場景和前後畫面由系統自動保持連續。</p>
        </div>
        <div className="sequence-flow-mini">
          <span>首幀</span><b>→</b><span>生成</span><b>→</b><span>末幀接力</span><b>→</b><span>合併</span>
        </div>
      </section>

      {error && <div className="sequence-alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

      <div className="sequence-grid">
        <section className="sequence-creator">
          <div className="sequence-section-head">
            <div><span>01</span><h2>鎖定視覺參考</h2></div>
            <small>推薦相同寬高比 · 上傳前自動優化至 900KB 內</small>
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
            <div><span>02</span><h2>設定動畫腳本</h2></div>
          </div>
          <div className="sequence-fields">
            <label className="sequence-field sequence-field-title">
              <span>作品名稱</span>
              <input value={title} maxLength={200} onChange={event => setTitle(event.target.value)} />
            </label>
            <label className="sequence-field sequence-field-prompt">
              <span>時間腳本 / 動作提示詞</span>
              <textarea
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                placeholder={SCRIPT_EXAMPLE}
                rows={6}
              />
              <div className="sequence-prompt-guide">
                <span>支援「0-5秒」「5s-10s」「00:10-00:15」；未寫時間的內容套用到整部動畫。</span>
                <button type="button" onClick={() => setPrompt(SCRIPT_EXAMPLE)}>插入範例</button>
              </div>
            </label>
            {parsedTimeline.length > 0 && (
              <div className="sequence-script-preview">
                <div className="sequence-script-preview-head"><strong>已識別 {parsedTimeline.length} 個時間動作</strong><span>系統將自動分配到 {segments} 個生成片段</span></div>
                <div>
                  {parsedTimeline.map((cue, index) => <span key={`${cue.time}-${index}`}><b>{cue.time}</b><em>{cue.action}</em></span>)}
                </div>
              </div>
            )}
            <div className="sequence-settings-row">
              <label className="sequence-field">
                <span>生成時長（整數）</span>
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
                  <b>秒</b>
                </div>
                <small>可輸入 5–300 秒，只接受整數。</small>
              </label>
              <div className="sequence-field">
                <span>效能策略</span>
                <div className="sequence-strategy-options" role="group" aria-label="單段生成時長">
                  {[5, 10, 15].map(seconds => (
                    <button
                      key={seconds}
                      type="button"
                      className={segmentSeconds === seconds ? "active" : ""}
                      onClick={() => setSegmentSeconds(seconds)}
                    >
                      <strong>{seconds}s</strong>
                      <small>{seconds === 5 ? "最穩定" : seconds === 10 ? "均衡" : "少分段"}</small>
                    </button>
                  ))}
                </div>
                <small>5 秒一致性較好；10 秒速度與穩定性均衡；15 秒分段最少。</small>
              </div>
              <label className="sequence-field">
                <span>隨機種子</span>
                <input type="number" value={seed} onChange={event => setSeed(Number(event.target.value))} />
                <small>-1 會隨機一次，所有分段共用同一種子。</small>
              </label>
            </div>
            <div className="sequence-duration-presets">
              <span>快速選擇</span>
              {[15, 30, 60, 120].map(seconds => <button key={seconds} type="button" className={totalSeconds === seconds ? "active" : ""} onClick={() => setTotalSeconds(seconds)}>{seconds} 秒</button>)}
            </div>
          </div>

          <div className="sequence-submit-bar">
            <div><strong>{segments}</strong><span>個分段 · 864×480 · 24 FPS</span></div>
            <button className="btn btn-primary sequence-generate" disabled={!ready} onClick={createSequence}>
              {submitting ? "上傳並建立中…" : "開始生成動畫"}
            </button>
          </div>
        </section>

        <aside className="sequence-monitor">
          <div className="sequence-monitor-head">
            <div><span>LIVE QUEUE</span><h2>製作進度</h2></div>
            <button className="comfy-icon-btn" onClick={refresh} title="重新整理">↻</button>
          </div>

          {selected ? (
            <div className="sequence-active">
              <div className="sequence-active-title">
                <div><strong>{selected.title}</strong><small>{new Date(selected.created_at).toLocaleString("zh-TW")}</small></div>
                <span className={`sequence-status is-${selected.status}`}>{STATUS[selected.status] ?? selected.status}</span>
              </div>
              {selected.final_output ? (
                <ResultPlayer output={selected.final_output} />
              ) : (
                <div className="sequence-progress-stage">
                  <div className="sequence-progress-ring" style={{ "--value": `${selected.progress * 3.6}deg` } as React.CSSProperties}>
                    <span>{selected.progress}%</span>
                  </div>
                  <div>
                    <strong>{selected.status === "stitching" ? "合併所有影片" : `生成第 ${Math.max(1, selected.current_segment)} / ${selected.total_segments} 段`}</strong>
                    <small>完成的分段會立即擷取末幀並傳給下一段</small>
                  </div>
                </div>
              )}

              <div className="sequence-timeline">
                {Array.from({ length: selected.total_segments }, (_, index) => {
                  const number = index + 1
                  const done = selected.segments.some(segment => segment.index === number)
                  const current = selected.current_segment === number && selected.status === "running"
                  return <div key={number} className={`${done ? "done" : ""} ${current ? "current" : ""}`}><i>{done ? "✓" : number}</i><span>分段 {number}</span></div>
                })}
                <div className={selected.status === "done" ? "done" : selected.status === "stitching" ? "current" : ""}><i>{selected.status === "done" ? "✓" : "∞"}</i><span>成片</span></div>
              </div>
              {selected.error && <div className="sequence-job-error">{selected.error}</div>}
              <div className="sequence-job-actions">
                {["queued", "running", "stitching"].includes(selected.status) && <button className="btn btn-sm" onClick={() => cancel(selected.id)}>取消任務</button>}
                {!(["queued", "running", "stitching"].includes(selected.status)) && <button className="btn btn-sm btn-danger" onClick={() => remove(selected.id)}>刪除任務與作品</button>}
              </div>
            </div>
          ) : <div className="sequence-empty"><span>◇</span><strong>尚無長動畫任務</strong><small>設定左側參數後開始第一個作品</small></div>}

          {sequences.length > 1 && (
            <div className="sequence-history">
              <h3>最近任務</h3>
              {sequences.map(item => (
                <button key={item.id} className={item.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
                  <span><strong>{item.title}</strong><small>{item.total_seconds}s · {item.total_segments} 段</small></span>
                  <em>{STATUS[item.status] ?? item.status}</em>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}