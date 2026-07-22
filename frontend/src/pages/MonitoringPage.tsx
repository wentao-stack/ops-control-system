import { useEffect, useState } from "react"
import { api } from "../auth"
import { HostMetrics } from "../types"

export function MonitoringPage() {
  const [metrics, setMetrics] = useState<HostMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api<HostMetrics>("/api/v1/host/metrics").then(setMetrics).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="empty">載入中…</div>

  return (
    <>
      <div className="page-header">
        <div>
          <h1>主機監控</h1>
          <p>{metrics?.hostname ?? "—"} · {metrics ? "即時數據" : "無法連線"}</p>
        </div>
        <button className="btn btn-sm" onClick={() => api<HostMetrics>("/api/v1/host/metrics").then(setMetrics)}>↻ 重新整理</button>
      </div>

      {!metrics && <div className="empty">無法取得主機監控數據</div>}

      {metrics && (
        <>
          <div className="host-metrics-row">
            <div className="host-card">
              <div className="host-card-label">CPU</div>
              <div className="host-card-value">{metrics.cpu_percent.toFixed(0)}%</div>
              <div className="host-bar"><span className={metrics.cpu_percent > 80 ? "high" : metrics.cpu_percent > 50 ? "mid" : ""} style={{ width: `${metrics.cpu_percent}%` }} /></div>
              <div className="host-card-sub">{metrics.cpu_count} 核心 · {metrics.cpu_freq_mhz.toFixed(0)} MHz · load {metrics.load_avg_1.toFixed(2)}</div>
            </div>
            <div className="host-card">
              <div className="host-card-label">記憶體</div>
              <div className="host-card-value">{metrics.mem_percent.toFixed(0)}%</div>
              <div className="host-bar"><span className={metrics.mem_percent > 80 ? "high" : metrics.mem_percent > 50 ? "mid" : ""} style={{ width: `${metrics.mem_percent}%` }} /></div>
              <div className="host-card-sub">{(metrics.mem_used_mb / 1024).toFixed(1)} / {(metrics.mem_total_mb / 1024).toFixed(1)} GiB</div>
            </div>
            <div className="host-card">
              <div className="host-card-label">磁碟</div>
              <div className="host-card-value">{metrics.disk_percent.toFixed(0)}%</div>
              <div className="host-bar"><span className={metrics.disk_percent > 80 ? "high" : metrics.disk_percent > 50 ? "mid" : ""} style={{ width: `${metrics.disk_percent}%` }} /></div>
              <div className="host-card-sub">{(metrics.disk_used_mb / 1024 / 1024).toFixed(1)} / {(metrics.disk_total_mb / 1024 / 1024).toFixed(1)} TiB</div>
            </div>
            <div className="host-card">
              <div className="host-card-label">運行時間</div>
              <div className="host-card-value">{metrics.uptime_seconds > 86400 ? (metrics.uptime_seconds / 86400).toFixed(0) + " 天" : (metrics.uptime_seconds / 3600).toFixed(0) + " 小時"}</div>
              <div className="host-card-sub">swap {(metrics.swap_used_mb / 1024).toFixed(1)} / {(metrics.swap_total_mb / 1024).toFixed(1)} GiB</div>
            </div>
          </div>

          {metrics.gpus.length > 0 && (
            <div className="gpu-section">
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>GPU — {metrics.gpus.length} 裝置</h3>
              <div className="gpu-grid">
                {metrics.gpus.map((gpu, i) => (
                  <div className="gpu-card" key={i}>
                    <strong>{gpu.name}</strong>
                    <div className="gpu-row"><span className="gpu-label">溫度</span><span className={`gpu-val ${gpu.temperature_c > 80 ? "hot" : gpu.temperature_c > 70 ? "warm" : ""}`}>{gpu.temperature_c}°C</span></div>
                    <div className="gpu-row"><span className="gpu-label">使用率</span><div className="gpu-bar"><span style={{ width: `${gpu.utilization_gpu}%` }} /></div><span className="gpu-val">{gpu.utilization_gpu}%</span></div>
                    <div className="gpu-row"><span className="gpu-label">VRAM</span><div className="gpu-bar"><span style={{ width: `${gpu.memory_total_mb > 0 ? (gpu.memory_used_mb / gpu.memory_total_mb) * 100 : 0}%` }} /></div><span className="gpu-val">{gpu.memory_used_mb} / {gpu.memory_total_mb} MiB</span></div>
                    <div className="gpu-row"><span className="gpu-label">功耗</span><span className="gpu-val">{gpu.power_draw_w.toFixed(0)} W</span></div>
                    <div className="gpu-row"><span className="gpu-label">風扇</span><span className="gpu-val">{gpu.fan_speed}%</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
