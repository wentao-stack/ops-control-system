/** Prepare a browser-selected image before it crosses the public proxy.
 *
 * ComfyUI's H3 video workflows work best with a 16:9 first frame.  Creating
 * the small, normalized file in the browser also keeps uploads below common
 * reverse-proxy request limits instead of sending a multi-megabyte original.
 */
const TARGET_WIDTH = 1344
const TARGET_HEIGHT = 768
const TARGET_BYTES = 850 * 1024
const MIN_WIDTH = 768

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("圖片轉換失敗")), type, quality)
  })
}

function loadImage(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => resolve({ image, url })
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`無法讀取圖片「${file.name}」`))
    }
    image.src = url
  })
}

/**
 * Converts any browser-decodable image into a compact, 16:9 JPEG suitable for
 * the H3 image-to-video workflows.  The source is center-cropped only when
 * needed to preserve its aspect ratio; it is never uploaded at original size.
 */
export async function prepareComfyWorkflowImage(file: File): Promise<File> {
  const { image, url } = await loadImage(file)
  try {
    if (!image.naturalWidth || !image.naturalHeight) throw new Error(`無法讀取圖片「${file.name}」`)

    let width = TARGET_WIDTH
    let height = TARGET_HEIGHT
    let quality = 0.88
    let blob: Blob | null = null

    // JPEG is intentionally used here: it is supported by every target browser
    // and reaches a stable size for photographic first-frame uploads.
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext("2d")
      if (!context) throw new Error("瀏覽器不支援圖片轉換")
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = "high"

      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
      const drawnWidth = image.naturalWidth * scale
      const drawnHeight = image.naturalHeight * scale
      context.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight)
      blob = await toBlob(canvas, "image/jpeg", quality)
      if (blob.size <= TARGET_BYTES) break

      if (quality > 0.38) quality -= 0.1
      else if (width > MIN_WIDTH) {
        width = Math.max(MIN_WIDTH, Math.round(width * 0.84 / 2) * 2)
        height = Math.round(width * TARGET_HEIGHT / TARGET_WIDTH / 2) * 2
        quality = 0.72
      }
    }

    if (!blob || blob.size > TARGET_BYTES) throw new Error("圖片無法壓縮成可安全上傳的大小")
    const stem = file.name.replace(/\.[^.]+$/, "") || "comfy-input"
    return new File([blob], `${stem}.jpg`, { type: "image/jpeg", lastModified: Date.now() })
  } finally {
    URL.revokeObjectURL(url)
  }
}
