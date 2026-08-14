"""Collect host metrics from remote servers via SSH."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .remote import ssh_exec


@dataclass
class RemoteGPUMetrics:
    name: str = ""
    temperature_c: int = 0
    utilization_gpu: int = 0
    memory_used_mb: int = 0
    memory_total_mb: int = 0
    power_draw_w: float = 0.0
    fan_speed: int = 0


@dataclass
class RemoteHostMetrics:
    asset_id: str = ""
    name: str = ""
    hostname: str = ""
    reachable: bool = True
    error: str = ""
    uptime_seconds: float = 0.0
    cpu_percent: float = 0.0
    cpu_count: int = 0
    load_avg_1: float = 0.0
    load_avg_5: float = 0.0
    load_avg_15: float = 0.0
    mem_total_mb: int = 0
    mem_used_mb: int = 0
    mem_available_mb: int = 0
    mem_percent: float = 0.0
    swap_total_mb: int = 0
    swap_used_mb: int = 0
    swap_percent: float = 0.0
    disk_total_mb: int = 0
    disk_used_mb: int = 0
    disk_free_mb: int = 0
    disk_percent: float = 0.0
    gpus: list[RemoteGPUMetrics] = field(default_factory=list)


# Shell script to collect all metrics in one SSH call
# Uses /proc filesystem for reliability — no external commands needed
METRICS_SCRIPT = r"""
(
  # hostname — try multiple methods
  echo "===HOSTNAME==="
  { cat /etc/hostname 2>/dev/null || uname -n 2>/dev/null || echo "unknown"; } | head -1

  # uptime (seconds)
  echo "===UPTIME==="
  awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0

  # CPU count
  echo "===CPU_COUNT==="
  grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1

  # load average
  echo "===LOAD_AVG==="
  awk '{print $1, $2, $3}' /proc/loadavg 2>/dev/null || echo "0 0 0"

  # CPU usage (1-second sample from /proc/stat)
  echo "===CPU_PERCENT==="
  (
    read -r cpu_line1 < /proc/stat
    sleep 1
    read -r cpu_line2 < /proc/stat
    echo "$cpu_line1" "$cpu_line2" | awk '{
      user1=$2; nice1=$3; system1=$4; idle1=$5; iowait1=$6; irq1=$7; softirq1=$8;
      user2=$13; nice2=$14; system2=$15; idle2=$16; iowait2=$17; irq2=$18; softirq2=$19;
      total1=user1+nice1+system1+idle1+iowait1+irq1+softirq1;
      total2=user2+nice2+system2+idle2+iowait2+irq2+softirq2;
      diff_idle=idle2-idle1; diff_total=total2-total1;
      if (diff_total > 0) printf "%.1f\n", (diff_total-diff_idle)*100/diff_total
      else print 0
    }'
  )

  # Memory (MB) — MemTotal, MemAvailable, MemUsed
  echo "===MEMORY==="
  awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {avail=$2} END {print int(total/1024); print int((total-avail)/1024); print int(avail/1024)}' /proc/meminfo

  # Swap (MB)
  echo "===SWAP==="
  awk '/^SwapTotal:/ {total=$2} /^SwapFree:/ {free=$2} END {print int(total/1024); print int(free/1024)}' /proc/meminfo

  # Disk usage of /
  echo "===DISK==="
  df -B1 / 2>/dev/null | awk 'NR==2 {printf "%d %d %d %s\n", int($2/1048576), int($3/1048576), int($4/1048576), $5}'

  # GPU (nvidia-smi)
  echo "===GPU==="
  if command -v nvidia-smi &>/dev/null; then
    nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,fan.speed --format=csv,noheader,nounits 2>/dev/null || echo "N/A"
  else
    echo "N/A"
  fi
) 2>/dev/null
"""


def _parse_metrics(output: str) -> RemoteHostMetrics:
    """Parse the multi-section output from METRICS_SCRIPT."""
    metrics = RemoteHostMetrics()

    sections: dict[str, str] = {}
    current = None
    lines: list[str] = []

    for line in output.splitlines():
        if line.startswith("===") and line.endswith("==="):
            if current:
                sections[current] = "\n".join(lines)
            current = line[3:-3]
            lines = []
        else:
            lines.append(line)
    if current:
        sections[current] = "\n".join(lines)

    # hostname
    metrics.hostname = sections.get("HOSTNAME", "").strip()

    # uptime
    try:
        metrics.uptime_seconds = float(sections.get("UPTIME", "0").strip())
    except ValueError:
        pass

    # cpu count
    try:
        metrics.cpu_count = int(sections.get("CPU_COUNT", "0").strip())
    except ValueError:
        pass

    # load avg
    load_parts = sections.get("LOAD_AVG", "").strip().split()
    if len(load_parts) >= 3:
        try:
            metrics.load_avg_1 = float(load_parts[0])
            metrics.load_avg_5 = float(load_parts[1])
            metrics.load_avg_15 = float(load_parts[2])
        except ValueError:
            pass

    # cpu percent
    try:
        metrics.cpu_percent = float(sections.get("CPU_PERCENT", "0").strip())
    except ValueError:
        pass

    # memory
    mem_lines = sections.get("MEMORY", "").strip().splitlines()
    mem_vals = []
    for l in mem_lines:
        try:
            mem_vals.append(int(l.strip()))
        except ValueError:
            pass
    if len(mem_vals) >= 3:
        metrics.mem_total_mb = mem_vals[0]
        metrics.mem_used_mb = mem_vals[1]
        metrics.mem_available_mb = mem_vals[2]
    elif len(mem_vals) >= 2:
        metrics.mem_total_mb = mem_vals[0]
        metrics.mem_available_mb = mem_vals[1]
        metrics.mem_used_mb = metrics.mem_total_mb - metrics.mem_available_mb
    if metrics.mem_total_mb > 0:
        metrics.mem_percent = round(metrics.mem_used_mb / metrics.mem_total_mb * 100, 1)

    # swap
    swap_lines = sections.get("SWAP", "").strip().splitlines()
    swap_vals = []
    for l in swap_lines:
        try:
            swap_vals.append(int(l.strip()))
        except ValueError:
            pass
    if len(swap_vals) >= 2:
        metrics.swap_total_mb = swap_vals[0]
        free = swap_vals[1]
        metrics.swap_used_mb = swap_vals[0] - free
        if metrics.swap_total_mb > 0:
            metrics.swap_percent = round(metrics.swap_used_mb / metrics.swap_total_mb * 100, 1)

    # disk
    disk_str = sections.get("DISK", "").strip()
    disk_parts = disk_str.split()
    if len(disk_parts) >= 4:
        try:
            metrics.disk_total_mb = int(disk_parts[0])
            metrics.disk_used_mb = int(disk_parts[1])
            metrics.disk_free_mb = int(disk_parts[2])
            pct_str = disk_parts[3].replace("%", "")
            metrics.disk_percent = float(pct_str)
        except (ValueError, IndexError):
            pass

    # GPU
    gpu_section = sections.get("GPU", "").strip()
    if gpu_section and gpu_section != "N/A":
        for line in gpu_section.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 8:
                continue
            try:
                gpu = RemoteGPUMetrics(
                    name=parts[1],
                    temperature_c=int(parts[2]) if parts[2] != "N/A" else 0,
                    utilization_gpu=int(parts[3]) if parts[3] != "N/A" else 0,
                    memory_used_mb=int(parts[4]) if parts[4] != "N/A" else 0,
                    memory_total_mb=int(parts[5]) if parts[5] != "N/A" else 0,
                    power_draw_w=float(parts[6]) if parts[6] != "N/A" else 0.0,
                    fan_speed=int(parts[7]) if parts[7] != "N/A" else 0,
                )
                metrics.gpus.append(gpu)
            except (ValueError, IndexError):
                continue

    return metrics


def collect_remote_metrics(host: str, port: int, user: str, asset_id: str, name: str, timeout: int = 60) -> RemoteHostMetrics:
    """Collect metrics from a remote host via SSH."""
    result = RemoteHostMetrics(asset_id=asset_id, name=name)

    r = ssh_exec(host, port, user, METRICS_SCRIPT, timeout=timeout)
    if r["exit_code"] != 0:
        result.reachable = False
        result.error = r.get("stderr", "SSH connection failed").strip()
        return result

    result = _parse_metrics(r["stdout"])
    result.asset_id = asset_id
    result.name = name
    return result


def save_metrics_to_history(metrics: RemoteHostMetrics) -> int | None:
    """Save metrics snapshot to history table. Returns history id or None."""
    from datetime import UTC, datetime
    from .models import MetricsHistory, MetricsHistoryGPU
    from .database import SessionLocal

    if not metrics.reachable:
        return None

    session = SessionLocal()
    try:
        now = datetime.now(UTC).replace(microsecond=0)
        h = MetricsHistory(
            asset_id=metrics.asset_id,
            hostname=metrics.hostname,
            cpu_percent=metrics.cpu_percent,
            cpu_count=metrics.cpu_count,
            load_avg_1=metrics.load_avg_1,
            load_avg_5=metrics.load_avg_5,
            load_avg_15=metrics.load_avg_15,
            mem_total_mb=metrics.mem_total_mb,
            mem_used_mb=metrics.mem_used_mb,
            mem_available_mb=metrics.mem_available_mb,
            mem_percent=metrics.mem_percent,
            swap_total_mb=metrics.swap_total_mb,
            swap_used_mb=metrics.swap_used_mb,
            swap_percent=metrics.swap_percent,
            disk_total_mb=metrics.disk_total_mb,
            disk_used_mb=metrics.disk_used_mb,
            disk_free_mb=metrics.disk_free_mb,
            disk_percent=metrics.disk_percent,
            collected_at=now,
        )
        session.add(h)
        session.flush()

        # GPU
        for gpu in metrics.gpus:
            g = MetricsHistoryGPU(
                history_id=h.id,
                name=gpu.name,
                temperature_c=gpu.temperature_c,
                utilization_gpu=gpu.utilization_gpu,
                memory_used_mb=gpu.memory_used_mb,
                memory_total_mb=gpu.memory_total_mb,
                power_draw_w=gpu.power_draw_w,
                fan_speed=gpu.fan_speed,
            )
            session.add(g)

        session.commit()
        return h.id
    except Exception:
        session.rollback()
        return None
    finally:
        session.close()
