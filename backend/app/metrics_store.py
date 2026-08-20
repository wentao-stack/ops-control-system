"""Shared metrics collection + history queries (K-line / series aggregation).

The background collector in main.py calls :func:`collect_all_hosts` and
:func:`save_local_to_history` every cycle; the monitoring history dashboard
calls :func:`query_series` for chart data.

Storage: the existing SQLite ``metrics_history`` / ``metrics_history_gpu``
tables (already indexed on ``asset_id + collected_at``). Retention is
enforced by :func:`purge_old_history` (default 90 days).
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Asset, MetricsHistory, MetricsHistoryGPU
from .remote_monitor import collect_remote_metrics, save_metrics_to_history
from .schemas import RemoteGPUMetricsResponse, RemoteHostMetricsResponse

# Sentinel asset id used for the backend host itself.
LOCAL_ASSET_ID = "local"
# How long to keep raw samples (60s cadence ≈ 129k rows/host at 90 days).
RETENTION_DAYS = 90
# Per-host SSH timeout used by the background collector (page-triggered
# collection keeps the longer timeout in main.py).
COLLECT_TIMEOUT = 30


def _to_response(raw) -> RemoteHostMetricsResponse:
    return RemoteHostMetricsResponse(
        asset_id=raw.asset_id,
        name=raw.name,
        hostname=raw.hostname,
        reachable=raw.reachable,
        error=raw.error,
        cpu_percent=raw.cpu_percent,
        cpu_count=raw.cpu_count,
        load_avg_1=raw.load_avg_1,
        load_avg_5=raw.load_avg_5,
        load_avg_15=raw.load_avg_15,
        mem_total_mb=raw.mem_total_mb,
        mem_used_mb=raw.mem_used_mb,
        mem_available_mb=raw.mem_available_mb,
        mem_percent=raw.mem_percent,
        swap_total_mb=raw.swap_total_mb,
        swap_used_mb=raw.swap_used_mb,
        swap_percent=raw.swap_percent,
        disk_total_mb=raw.disk_total_mb,
        disk_used_mb=raw.disk_used_mb,
        disk_free_mb=raw.disk_free_mb,
        disk_percent=raw.disk_percent,
        gpus=[RemoteGPUMetricsResponse(**g.__dict__) for g in raw.gpus],
    )


async def collect_all_hosts(session: Session, timeout: int = COLLECT_TIMEOUT) -> list[RemoteHostMetricsResponse]:
    """Collect metrics from all SSH-configured hosts in parallel.

    Snapshots of reachable hosts are persisted to ``metrics_history`` as a
    side effect, so every collection (page-triggered or background) feeds
    the history dashboard.
    """
    assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()

    async def _collect(asset: Asset):
        return await asyncio.to_thread(
            collect_remote_metrics,
            host=asset.ssh_host,  # type: ignore[arg-type]
            port=asset.ssh_port or 22,
            user=asset.ssh_user,  # type: ignore[arg-type]
            asset_id=asset.id,
            name=asset.name,
            timeout=timeout,
        )

    raws = await asyncio.gather(*[_collect(a) for a in assets])
    for raw in raws:
        if raw.reachable:
            await asyncio.to_thread(save_metrics_to_history, raw)
    return [_to_response(r) for r in raws]


def save_local_to_history(metrics) -> int | None:
    """Persist a local (backend host) snapshot to history.

    Accepts the monitor.HostMetrics dataclass (no asset_id/name fields).
    """
    from .remote_monitor import RemoteGPUMetrics, RemoteHostMetrics

    remote = RemoteHostMetrics(
        asset_id=LOCAL_ASSET_ID,
        name="local",
        hostname=metrics.hostname,
        reachable=True,
        uptime_seconds=metrics.uptime_seconds,
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
        gpus=[RemoteGPUMetrics(**g.__dict__) for g in metrics.gpus],
    )
    return save_metrics_to_history(remote)


def purge_old_history(session: Session, days: int = RETENTION_DAYS) -> int:
    """Delete history rows older than ``days``. Returns deleted row count."""
    cutoff = datetime.now(UTC) - timedelta(days=days)
    ids = (
        session.query(MetricsHistory.id)
        .filter(MetricsHistory.collected_at < cutoff)
        .all()
    )
    id_list = [i[0] for i in ids]
    if not id_list:
        return 0
    for i in range(0, len(id_list), 2000):
        chunk = id_list[i : i + 2000]
        session.query(MetricsHistoryGPU).filter(MetricsHistoryGPU.history_id.in_(chunk)).delete(synchronize_session=False)
        session.query(MetricsHistory).filter(MetricsHistory.id.in_(chunk)).delete(synchronize_session=False)
    session.commit()
    return len(id_list)


# ── Chart aggregation ────────────────────────────────────────────────────────

_KLINE_METRICS = ("cpu", "mem", "disk", "swap")
_KLINE_COLUMNS = {
    "cpu": "cpu_percent",
    "mem": "mem_percent",
    "disk": "disk_percent",
    "swap": "swap_percent",
}


def _bucketed(timestamps: list[float], start_ts: float, end_ts: float, buckets: int, values: list[float | None]) -> list[list[float]]:
    """Group per-row values into ``buckets`` time buckets (avg per bucket)."""
    span = max(end_ts - start_ts, 1.0)
    size = span / buckets
    acc: list[list[float]] = [[] for _ in range(buckets)]
    for ts, v in zip(timestamps, values):
        if v is None:
            continue
        idx = int((ts - start_ts) / size)
        if idx >= buckets:
            idx = buckets - 1
        if idx < 0:
            idx = 0
        acc[idx].append(v)
    return acc


def _avg_series(acc: list[list[float]]) -> list[float | None]:
    return [sum(a) / len(a) if a else None for a in acc]


def _kline_series(acc: list[list[float]]) -> list[dict]:
    out = []
    for a in acc:
        if not a:
            out.append(None)
            continue
        out.append({
            "o": a[0],
            "h": max(a),
            "l": min(a),
            "c": a[-1],
            "a": sum(a) / len(a),
        })
    return out


def query_series(session: Session, asset_id: str, hours: float, buckets: int) -> dict:
    """Aggregate raw history rows into chart-ready series.

    Returns candlestick data (open/high/low/close/avg) per time bucket for
    the four usage metrics, line data for load/memory/disk details, and per-GU
    line data. Missing values are ``null``.
    """
    now = datetime.now(UTC)
    start = now - timedelta(hours=hours)
    start_ts = start.timestamp()
    end_ts = now.timestamp()

    rows = (
        session.query(MetricsHistory)
        .filter(
            MetricsHistory.asset_id == asset_id,
            MetricsHistory.collected_at >= start,
        )
        .order_by(MetricsHistory.collected_at.asc())
        .all()
    )

    klines: dict[str, list] = {m: [] for m in _KLINE_METRICS}
    lines: dict[str, list] = {
        "load1": [], "load5": [], "load15": [],
        "mem_used_gb": [], "mem_total_gb": [],
        "disk_used_gb": [], "disk_total_gb": [],
    }
    gpus_out: list[dict] = []
    hostname: str | None = None
    times: list[int] = []

    if rows:
        hostname = rows[0].hostname
        times = [int(start_ts + i * (end_ts - start_ts) / buckets) for i in range(buckets)]
        ts = [r.collected_at.timestamp() if r.collected_at.tzinfo else (r.collected_at.replace(tzinfo=UTC).timestamp()) for r in rows]

        for m in _KLINE_METRICS:
            col = _KLINE_COLUMNS[m]
            acc = _bucketed(ts, start_ts, end_ts, buckets, [getattr(r, col) for r in rows])
            klines[m] = _kline_series(acc)

        for key, attr, scale in (
            ("load1", "load_avg_1", 1),
            ("load5", "load_avg_5", 1),
            ("load15", "load_avg_15", 1),
            ("mem_used_gb", "mem_used_mb", 1 / 1024),
            ("mem_total_gb", "mem_total_mb", 1 / 1024),
            ("disk_used_gb", "disk_used_mb", 1 / (1024 * 1024)),
            ("disk_total_gb", "disk_total_mb", 1 / (1024 * 1024)),
        ):
            vals = [getattr(r, attr) * scale for r in rows]
            lines[key] = _avg_series(_bucketed(ts, start_ts, end_ts, buckets, vals))

        # GPU rows — id range avoids SQLite variable limits on large IN lists.
        # GPUs have no unique key; a GPU's identity is its position (index)
        # within its snapshot, which is stable across nvidia-smi output.
        gpu_rows = (
            session.query(MetricsHistoryGPU)
            .filter(
                MetricsHistoryGPU.history_id >= rows[0].id,
                MetricsHistoryGPU.history_id <= rows[-1].id,
            )
            .order_by(MetricsHistoryGPU.id.asc())
            .all()
        )
        valid_ids = {r.id for r in rows}
        by_hist: dict[int, list] = defaultdict(list)
        for g in gpu_rows:
            if g.history_id in valid_ids:
                by_hist[g.history_id].append(g)

        max_gpus = max((len(v) for v in by_hist.values()), default=0)
        cols = {
            "util": "utilization_gpu",
            "temp": "temperature_c",
            "power": "power_draw_w",
            "vram_used": "memory_used_mb",
            "vram_total": "memory_total_mb",
        }
        for gpu_idx in range(max_gpus):
            name = ""
            for r in rows:
                gs = by_hist.get(r.id, [])
                if gpu_idx < len(gs) and gs[gpu_idx].name:
                    name = gs[gpu_idx].name
                    break
            entry: dict = {"idx": gpu_idx, "name": name}
            for key, attr in cols.items():
                vals: list[float | None] = []
                for r in rows:
                    gs = by_hist.get(r.id, [])
                    vals.append(getattr(gs[gpu_idx], attr) if gpu_idx < len(gs) else None)
                entry[key] = _avg_series(_bucketed(ts, start_ts, end_ts, buckets, vals))
            gpus_out.append(entry)

    return {
        "asset_id": asset_id,
        "hostname": hostname,
        "buckets": buckets,
        "times": times,
        "klines": klines,
        "lines": lines,
        "gpus": gpus_out,
        "record_count": len(rows),
        "earliest": rows[0].collected_at.isoformat() if rows else None,
        "latest": rows[-1].collected_at.isoformat() if rows else None,
    }
