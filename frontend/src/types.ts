export type Health = "healthy" | "warning" | "critical" | "unknown"

export type Asset = {
  id: string; name: string; asset_type: string; environment: string;
  owner: string; criticality: string; health_status: Health;
  health_summary: string | null; last_seen_at: string | null;
  ssh_host?: string | null; ssh_port?: number | null; ssh_user?: string | null;
}

export type Service = {
  id: string; name: string; service_type: string;
  status: Health; status_summary: string | null; observed_at: string | null;
}

export type AssetDetail = Asset & { services: Service[] }

export type Summary = {
  total: number;
  by_health: Record<Health, number>;
  by_environment: Record<string, number>;
  generated_at: string;
}

export type GPUMetric = {
  name: string; temperature_c: number; utilization_gpu: number;
  memory_used_mb: number; memory_total_mb: number;
  power_draw_w: number; fan_speed: number;
}

export type HostMetrics = {
  timestamp: string; hostname: string; uptime_seconds: number;
  cpu_percent: number; cpu_count: number; cpu_freq_mhz: number;
  load_avg_1: number; load_avg_5: number; load_avg_15: number;
  mem_total_mb: number; mem_used_mb: number; mem_available_mb: number; mem_percent: number;
  swap_total_mb: number; swap_used_mb: number; swap_percent: number;
  disk_total_mb: number; disk_used_mb: number; disk_free_mb: number; disk_percent: number;
  gpus: GPUMetric[];
}

export type RemoteHostMetric = {
  asset_id: string; name: string; hostname: string;
  reachable: boolean; error: string;
  cpu_percent: number; cpu_count: number;
  load_avg_1: number; load_avg_5: number; load_avg_15: number;
  mem_total_mb: number; mem_used_mb: number; mem_available_mb: number; mem_percent: number;
  swap_total_mb: number; swap_used_mb: number; swap_percent: number;
  disk_total_mb: number; disk_used_mb: number; disk_free_mb: number; disk_percent: number;
  gpus: GPUMetric[];
}

export type RemoteHostsMetrics = {
  hosts: RemoteHostMetric[];
  collected_at: string;
}

export type RemoteAsset = {
  id: string; name: string;
  ssh_host: string | null; ssh_port: number | null; ssh_user: string | null;
}

export type RemoteExecResult = {
  stdout: string; stderr: string; exit_code: number; duration: number;
}

export type RemotePingResult = {
  asset_id: string; name: string; reachable: boolean;
}

export const HEALTH_LABELS: Record<Health, string> = {
  healthy: "正常", warning: "警告", critical: "嚴重", unknown: "未知",
}

export const fmt = (v: string | null) =>
  v ? new Intl.DateTimeFormat("zh-Hant", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(v)) : "—"

export const fmtRel = (v: string) => {
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 60000)
  if (d < 1) return "剛剛"
  if (d < 60) return `${d} 分鐘前`
  if (d < 1440) return `${Math.floor(d / 60)} 小時前`
  return `${Math.floor(d / 1440)} 天前`
}

// ── Supervisor process management types ────────────────────────────────────

export type SupervisorProcess = {
  name: string
  group: string
  display_name: string
  status: string  // RUNNING, STOPPED, STARTING, STOPPING, FATAL, BACKOFF
  pid: number
  uptime: string
}

export type SupervisorHostStatus = {
  asset_id: string
  name: string
  hostname: string
  reachable: boolean
  error: string
  processes: SupervisorProcess[]
}

export type SupervisorAllStatus = {
  hosts: SupervisorHostStatus[]
  collected_at: string
}

export type SupervisorActionResult = {
  success: boolean
  process: string
  message: string
  stdout: string
  stderr: string
}

export type SupervisorTailResult = {
  process: string
  lines: string[]
  truncated: boolean
}
