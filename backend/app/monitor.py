"""Host resource collector — CPU, memory, disk, GPU (nvidia-smi)."""

from __future__ import annotations

import socket
import subprocess
from dataclasses import dataclass, field
from datetime import UTC, datetime

import psutil


@dataclass
class GPUMetrics:
    name: str = ""
    temperature_c: int = 0
    utilization_gpu: int = 0
    memory_used_mb: int = 0
    memory_total_mb: int = 0
    power_draw_w: float = 0.0
    fan_speed: int = 0


@dataclass
class HostMetrics:
    timestamp: str = ""
    hostname: str = ""
    uptime_seconds: float = 0.0
    cpu_percent: float = 0.0
    cpu_count: int = 0
    cpu_freq_mhz: float = 0.0
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
    gpus: list[GPUMetrics] = field(default_factory=list)


def _collect_cpu() -> dict:
    cpu_pct = psutil.cpu_percent(interval=0.5)  # blocks 500ms for accurate reading
    freq = psutil.cpu_freq()
    loadavg = psutil.getloadavg()
    return {
        "cpu_percent": cpu_pct,
        "cpu_count": psutil.cpu_count(),
        "cpu_freq_mhz": freq.current if freq else 0.0,
        "load_avg_1": loadavg[0],
        "load_avg_5": loadavg[1],
        "load_avg_15": loadavg[2],
    }


def _collect_memory() -> dict:
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    mb = 1024 * 1024
    return {
        "mem_total_mb": vm.total // mb,
        "mem_used_mb": vm.used // mb,
        "mem_available_mb": vm.available // mb,
        "mem_percent": vm.percent,
        "swap_total_mb": sw.total // mb,
        "swap_used_mb": sw.used // mb,
        "swap_percent": sw.percent,
    }


def _collect_disk() -> dict:
    sd = psutil.disk_usage("/")
    mb = 1024 * 1024
    return {
        "disk_total_mb": sd.total // mb,
        "disk_used_mb": sd.used // mb,
        "disk_free_mb": sd.free // mb,
        "disk_percent": sd.percent,
    }


def _collect_gpu() -> list[GPUMetrics]:
    """Parse nvidia-smi CSV output for each GPU."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,temperature.gpu,utilization.gpu,"
                "memory.used,memory.total,power.draw,fan.speed",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return []

        gpus: list[GPUMetrics] = []
        for line in result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 8:
                continue
            gpus.append(
                GPUMetrics(
                    name=parts[1],
                    temperature_c=int(parts[2]) if parts[2] != "N/A" else 0,
                    utilization_gpu=int(parts[3]) if parts[3] != "N/A" else 0,
                    memory_used_mb=int(parts[4]) if parts[4] != "N/A" else 0,
                    memory_total_mb=int(parts[5]) if parts[5] != "N/A" else 0,
                    power_draw_w=float(parts[6]) if parts[6] != "N/A" else 0.0,
                    fan_speed=int(parts[7]) if parts[7] != "N/A" else 0,
                )
            )
        return gpus
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
        return []


def collect_host_metrics() -> HostMetrics:
    """Gather a single snapshot of all host metrics."""
    boot = psutil.boot_time()
    uptime_sec = datetime.now().timestamp() - boot

    cpu = _collect_cpu()
    mem = _collect_memory()
    disk = _collect_disk()
    gpus = _collect_gpu()

    metrics = HostMetrics(
        timestamp=datetime.now(UTC).isoformat(),
        hostname=socket.gethostname(),
        uptime_seconds=uptime_sec,
        **cpu,
        **mem,
        **disk,
        gpus=gpus,
    )
    return metrics
