from __future__ import annotations

import asyncio
import logging
import re
import time as _time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .auth import ACCESS_TOKEN_EXPIRE_MINUTES, create_access_token, decode_ws_token, get_current_user, get_session, is_valid_comfy_media_token, verify_password
from .database import Base, SessionLocal, engine
from .models import Alert, Asset, AssetService, Change, Note, Runbook, User, ExecLog
from .agent_models import AgentConversation, AgentMessage, AgentRun, AgentStep  # noqa: F401 — ensure tables are created
from .comfyui_models import ComfyArtifactRecord, ComfyJob  # noqa: F401 — ensure tables are created
from .comfyui_sequence_models import ComfySequence  # noqa: F401 — ensure tables are created
from .share_models import SharePost  # noqa: F401 — ensure tables are created
from .remote import ssh_exec, ssh_ping
from .remote_monitor import collect_remote_metrics
from .remote_service import detect_remote_services
from .remote_supervisor import (
    SupervisorLogLines, SupervisorProcess,
    supervisor_action, supervisor_status, supervisor_tail,
)
from .schemas import (
    AlertListResponse, AlertResponse, AssetDetailResponse, AssetListResponse, AssetResponse,
    ChangeListResponse, ChangeResponse, GPUMetricsResponse, HostMetricsResponse,
    InventorySummaryResponse, LoginRequest, NoteCreate, NoteListResponse, NoteResponse, NoteUpdate,
    RemoteExecRequest, RemoteExecResponse, RemoteGPUMetricsResponse, RemoteHostMetricsResponse,
    RemoteHostsMetricsResponse, RemoteAllServicesResponse, RemoteHostServicesResponse,
    RemotePingResponse, RemoteServiceResponse, RunbookListResponse, RunbookResponse, ServiceResponse,
    SupervisorActionRequest, SupervisorActionResponse, SupervisorAllStatusResponse,
    SupervisorHostStatusResponse, SupervisorLogSourceResponse, SupervisorProcessResponse,
    SupervisorTailRequest, SupervisorTailResponse,
    TokenResponse, UserResponse,
    ExecLogResponse, ExecLogListResponse,
    CodeTreeItem, CodeTreeResponse, CodeFileResponse,
    VultrAccountResponse, VultrInstancesResponse,
    SharePostCreate, SharePostUpdate, SharePostStatusUpdate, SharePostResponse, SharePostListResponse,
)
from .monitor import collect_host_metrics
from .seed import seed_development_data
from . import webssh
from .workflow_engine import run_workflow
from .workflow_models import WorkflowTemplate, WorkflowExecution
from .workflow_schemas import (
    WorkflowRunRequest,
    WorkflowTemplateCreate,
    WorkflowTemplateUpdate,
    WorkflowTemplateResponse,
    WorkflowTemplateListResponse,
    WorkflowExecutionResponse,
    WorkflowExecutionDetailResponse,
    WorkflowExecutionListResponse,
    ExecutionStepResult,
)
from .workflow_templates import TEMPLATES as BUILTIN_TEMPLATES

import json
import logging
import os
import shutil
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse

from . import agent as agent_service
from .agent_models import AgentConversation, AgentMessage
from .agent_schemas import (
    AgentChatRequest,
    AgentConfirmRequest,
    AgentConversationCreate,
    AgentConversationListResponse,
    AgentConversationResponse,
    AgentHealthResponse,
    AgentInspectRequest,
    AgentInspectReport,
    AgentMemoryUpsert,
    AgentMessagesListResponse,
)
from . import clouds as clouds_service
from . import comfyui as comfyui_service
from . import comfyui_sequence as comfyui_sequence_service
from .comfyui_schemas import (
    ComfyArtifactListResponse,
    ComfyGenerateRequest,
    ComfyGenerateResponse,
    ComfyJobListResponse,
    ComfyJobResponse,
    ComfyStatusResponse,
    ComfyUploadResponse,
    ComfyWorkflowListResponse,
    ComfyWorkflowRenameRequest,
)
from .comfyui_sequence_schemas import (
    ComfySequenceCreate,
    ComfySequenceListResponse,
    ComfySequenceResponse,
)

# ── Simple response cache ────────────────────────────────────────────────────
_cache: dict[str, tuple[Any, float]] = {}
CACHE_TTL = 30  # seconds


def _cache_get(key: str) -> Any | None:
    if key in _cache:
        val, ts = _cache[key]
        if _time.monotonic() - ts < CACHE_TTL:
            return val
        del _cache[key]
    return None


def _cache_set(key: str, value: Any) -> None:
    _cache[key] = (value, _time.monotonic())


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Configure webssh logger to output to stdout
    webssh_logger = logging.getLogger("webssh")
    webssh_logger.setLevel(logging.INFO)
    if not webssh_logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        webssh_logger.addHandler(handler)

    Base.metadata.create_all(bind=engine)
    from .database import ensure_runbook_rag_columns
    ensure_runbook_rag_columns()
    with SessionLocal() as session:
        seed_development_data(session)

    # Build RAG index on startup
    try:
        from .agent_rag import build_full_index, get_index_stats
        with SessionLocal() as session:
            stats = build_full_index(session)
        print(f"[RAG] 索引啟動完成: {get_index_stats()}")
    except Exception as e:
        print(f"[RAG] 索引啟動失敗（不影響服務）: {e}")

    yield


app = FastAPI(title="Ops Control System API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "https://ops.sanbunto.online"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_session():
    with SessionLocal() as session:
        yield session


def serialize_asset(asset: Asset) -> AssetResponse:
    return AssetResponse(
        id=asset.id, name=asset.name, asset_type=asset.asset_type,
        environment=asset.environment, owner=asset.owner, criticality=asset.criticality,
        health_status=asset.health_status, health_summary=asset.health_summary,
        last_seen_at=asset.last_seen_at,
        ssh_host=asset.ssh_host,
        ssh_port=asset.ssh_port,
        ssh_user=asset.ssh_user,
        local_machine=asset.local_machine,
    )


@app.get("/api/v1/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "development-only"}


# ── Auth endpoints ────────────────────────────────────────────────────────────

@app.post("/api/v1/auth/login", response_model=TokenResponse)
def login(
    form: OAuth2PasswordRequestForm = Depends(),
    session: Session = Depends(get_session),
) -> TokenResponse:
    user = session.scalar(select(User).where(User.username == form.username))
    if user is None or not verify_password(form.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled")
    token = create_access_token(data={"sub": user.username})
    return TokenResponse(access_token=token, expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60)


@app.get("/api/v1/auth/me", response_model=UserResponse)
def get_me(user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        is_active=user.is_active,
    )


@app.get("/api/v1/inventory/summary", response_model=InventorySummaryResponse)
def inventory_summary(session: Session = Depends(get_session)) -> InventorySummaryResponse:
    by_health = {key: 0 for key in ("healthy", "warning", "critical", "unknown")}
    by_environment = {key: 0 for key in ("development", "staging", "production")}
    for status, count in session.execute(select(Asset.health_status, func.count()).group_by(Asset.health_status)):
        by_health[status] = count
    for environment, count in session.execute(select(Asset.environment, func.count()).group_by(Asset.environment)):
        by_environment[environment] = count
    return InventorySummaryResponse(total=sum(by_health.values()), by_health=by_health, by_environment=by_environment, generated_at=datetime.now(UTC))


@app.get("/api/v1/assets", response_model=AssetListResponse)
def list_assets(
    q: str | None = None,
    environment: str | None = None,
    health: str | None = None,
    asset_type: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    session: Session = Depends(get_session),
) -> AssetListResponse:
    query = select(Asset)
    if q:
        query = query.where(Asset.name.ilike(f"%{q.strip()}%"))
    if environment:
        query = query.where(Asset.environment == environment)
    if health:
        query = query.where(Asset.health_status == health)
    if asset_type:
        query = query.where(Asset.asset_type == asset_type)
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    assets = session.scalars(query.order_by(Asset.name).offset((page - 1) * page_size).limit(page_size)).all()
    return AssetListResponse(items=[serialize_asset(asset) for asset in assets], total=total, page=page, page_size=page_size, generated_at=datetime.now(UTC))


@app.get("/api/v1/assets/{asset_id}", response_model=AssetDetailResponse)
def get_asset(asset_id: str, session: Session = Depends(get_session)) -> AssetDetailResponse:
    asset = session.scalar(select(Asset).options(selectinload(Asset.services)).where(Asset.id == asset_id))
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    return AssetDetailResponse(
        **serialize_asset(asset).model_dump(),
        services=[ServiceResponse(id=item.id, name=item.name, service_type=item.service_type, status=item.status, status_summary=item.status_summary, observed_at=item.observed_at) for item in asset.services],
    )


# ── Alerts ───────────────────────────────────────────────────────────────────

@app.get("/api/v1/alerts", response_model=AlertListResponse)
def list_alerts(
    severity: str | None = None,
    acknowledged: bool | None = None,
    session: Session = Depends(get_session),
) -> AlertListResponse:
    q = select(Alert)
    if severity:
        q = q.where(Alert.severity == severity)
    if acknowledged is not None:
        q = q.where(Alert.acknowledged == acknowledged)
    total = session.scalar(select(func.count()).select_from(q.subquery())) or 0
    items = session.scalars(q.order_by(Alert.severity, Alert.created_at.desc()).limit(100)).all()
    return AlertListResponse(
        items=[AlertResponse(id=a.id, title=a.title, severity=a.severity, source=a.source, message=a.message, acknowledged=a.acknowledged, acknowledged_by=a.acknowledged_by, created_at=a.created_at, acknowledged_at=a.acknowledged_at) for a in items],
        total=total,
        generated_at=datetime.now(UTC),
    )


# ── Changes ──────────────────────────────────────────────────────────────────

@app.get("/api/v1/changes", response_model=ChangeListResponse)
def list_changes(
    change_type: str | None = None,
    status: str | None = None,
    session: Session = Depends(get_session),
) -> ChangeListResponse:
    q = select(Change)
    if change_type:
        q = q.where(Change.change_type == change_type)
    if status:
        q = q.where(Change.status == status)
    total = session.scalar(select(func.count()).select_from(q.subquery())) or 0
    items = session.scalars(q.order_by(Change.created_at.desc()).limit(100)).all()
    return ChangeListResponse(
        items=[ChangeResponse(id=c.id, title=c.title, change_type=c.change_type, status=c.status, author=c.author, description=c.description, affected_assets=c.affected_assets, created_at=c.created_at, completed_at=c.completed_at) for c in items],
        total=total,
        generated_at=datetime.now(UTC),
    )


# ── Runbooks ─────────────────────────────────────────────────────────────────

@app.get("/api/v1/runbooks", response_model=RunbookListResponse)
def list_runbooks(
    category: str | None = None,
    session: Session = Depends(get_session),
) -> RunbookListResponse:
    q = select(Runbook)
    if category:
        q = q.where(Runbook.category == category)
    total = session.scalar(select(func.count()).select_from(q.subquery())) or 0
    items = session.scalars(q.order_by(Runbook.title)).all()
    return RunbookListResponse(
        items=[RunbookResponse(id=r.id, title=r.title, category=r.category, description=r.description, steps=r.steps, author=r.author, created_at=r.created_at, updated_at=r.updated_at) for r in items],
        total=total,
        generated_at=datetime.now(UTC),
    )


# ── Remote SSH execution ─────────────────────────────────────────────────────

@app.post("/api/v1/remote/exec", response_model=RemoteExecResponse)
def remote_exec(
    req: RemoteExecRequest,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> RemoteExecResponse:
    asset = session.scalar(select(Asset).where(Asset.id == req.asset_id))
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.ssh_host is None or asset.ssh_user is None:
        raise HTTPException(status_code=400, detail="Asset has no SSH configuration")
    port = asset.ssh_port or 22
    result = ssh_exec(asset.ssh_host, port, asset.ssh_user, req.command, timeout=req.timeout)

    # Log execution
    session.add(
        ExecLog(
            asset_id=req.asset_id,
            command=req.command,
            stdout=result.get("stdout", ""),
            stderr=result.get("stderr", ""),
            exit_code=result.get("exit_code", -1),
            duration=result.get("duration", 0),
            user=user.username,
            created_at=datetime.now(UTC).replace(microsecond=0),
        )
    )
    session.commit()

    return RemoteExecResponse(**result)


@app.post("/api/v1/remote/ping", response_model=list[RemotePingResponse])
def remote_ping(session: Session = Depends(get_session)) -> list[RemotePingResponse]:
    """Ping all SSH-configured assets."""
    assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()
    results = []
    for asset in assets:
        port = asset.ssh_port or 22
        reachable = ssh_ping(asset.ssh_host, port, asset.ssh_user)  # type: ignore[arg-type]
        results.append(RemotePingResponse(asset_id=asset.id, name=asset.name, reachable=reachable))
    return results


# ── Host monitoring endpoints ────────────────────────────────────────────────

@app.get("/api/v1/host/metrics", response_model=HostMetricsResponse)
def host_metrics() -> HostMetricsResponse:
    """Return a live snapshot of this host's resource usage."""
    raw = collect_host_metrics()
    return HostMetricsResponse(
        timestamp=raw.timestamp,
        hostname=raw.hostname,
        uptime_seconds=raw.uptime_seconds,
        cpu_percent=raw.cpu_percent,
        cpu_count=raw.cpu_count,
        cpu_freq_mhz=raw.cpu_freq_mhz,
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
        gpus=[GPUMetricsResponse(**g.__dict__) for g in raw.gpus],
    )


@app.get("/api/v1/hosts/metrics", response_model=RemoteHostsMetricsResponse)
async def hosts_metrics(
    session: Session = Depends(get_session),
    cache: bool = Query(False, description="Use cached results if available"),
) -> RemoteHostsMetricsResponse:
    """Collect metrics from all SSH-configured hosts via SSH (parallel)."""
    cache_key = "hosts_metrics"
    if cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()

    async def _collect(asset: Asset) -> RemoteHostMetricsResponse:
        port = asset.ssh_port or 22
        raw = await asyncio.to_thread(
            collect_remote_metrics,
            host=asset.ssh_host,  # type: ignore[arg-type]
            port=port,
            user=asset.ssh_user,  # type: ignore[arg-type]
            asset_id=asset.id,
            name=asset.name,
            timeout=60,
        )
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

    hosts = await asyncio.gather(*[_collect(a) for a in assets])
    result = RemoteHostsMetricsResponse(hosts=list(hosts), collected_at=datetime.now(UTC).isoformat())
    _cache_set(cache_key, result)
    return result


# ── Metrics history ──────────────────────────────────────────────────────────


@app.get("/api/v1/metrics/history")
async def metrics_history_get(
    asset_id: str | None = Query(None, description="Filter by asset ID"),
    start: str | None = Query(None, description="ISO start time"),
    end: str | None = Query(None, description="ISO end time"),
    limit: int = Query(200, ge=1, le=2000, description="Max records"),
    session: Session = Depends(get_session),
):
    """Query metrics history with optional filters."""
    from .models import MetricsHistory, MetricsHistoryGPU
    from sqlalchemy import func

    q = session.query(MetricsHistory)
    if asset_id:
        q = q.filter(MetricsHistory.asset_id == asset_id)
    if start:
        q = q.filter(MetricsHistory.collected_at >= start)
    if end:
        q = q.filter(MetricsHistory.collected_at <= end)
    q = q.order_by(MetricsHistory.collected_at.desc()).limit(limit)

    records = q.all()
    result = []
    for r in records:
        gpus = session.query(MetricsHistoryGPU).filter(MetricsHistoryGPU.history_id == r.id).all()
        result.append({
            "id": r.id,
            "asset_id": r.asset_id,
            "hostname": r.hostname,
            "cpu_percent": r.cpu_percent,
            "cpu_count": r.cpu_count,
            "load_avg_1": r.load_avg_1,
            "load_avg_5": r.load_avg_5,
            "load_avg_15": r.load_avg_15,
            "mem_total_mb": r.mem_total_mb,
            "mem_used_mb": r.mem_used_mb,
            "mem_available_mb": r.mem_available_mb,
            "mem_percent": r.mem_percent,
            "swap_total_mb": r.swap_total_mb,
            "swap_used_mb": r.swap_used_mb,
            "swap_percent": r.swap_percent,
            "disk_total_mb": r.disk_total_mb,
            "disk_used_mb": r.disk_used_mb,
            "disk_free_mb": r.disk_free_mb,
            "disk_percent": r.disk_percent,
            "gpus": [{
                "name": g.name,
                "temperature_c": g.temperature_c,
                "utilization_gpu": g.utilization_gpu,
                "memory_used_mb": g.memory_used_mb,
                "memory_total_mb": g.memory_total_mb,
                "power_draw_w": g.power_draw_w,
                "fan_speed": g.fan_speed,
            } for g in gpus],
            "collected_at": r.collected_at.isoformat(),
        })

    # Stats
    stats_q = session.query(
        func.count(MetricsHistory.id).label("total"),
        func.min(MetricsHistory.collected_at).label("earliest"),
        func.max(MetricsHistory.collected_at).label("latest"),
    )
    stats = stats_q.first()

    return {
        "records": result,
        "total": stats.total if stats else 0,
        "earliest": stats.earliest.isoformat() if stats and stats.earliest else None,
        "latest": stats.latest.isoformat() if stats and stats.latest else None,
    }


@app.delete("/api/v1/metrics/history")
async def metrics_history_delete(
    days: int = Query(30, ge=1, description="Delete records older than N days"),
    session: Session = Depends(get_session),
):
    """Delete old metrics history records."""
    from datetime import timedelta
    from .models import MetricsHistory, MetricsHistoryGPU

    cutoff = datetime.now(UTC) - timedelta(days=days)
    # Delete GPUs first (foreign key)
    gpu_ids = session.query(MetricsHistory.id).filter(MetricsHistory.collected_at < cutoff).with_entities(MetricsHistory.id).scalar_subquery()
    deleted_gpus = session.query(MetricsHistoryGPU).filter(MetricsHistoryGPU.history_id.in_(gpu_ids)).delete(synchronize_session=False)
    deleted = session.query(MetricsHistory).filter(MetricsHistory.collected_at < cutoff).delete(synchronize_session=False)
    session.commit()
    return {"deleted_history": deleted, "deleted_gpu": deleted_gpus}


@app.get("/api/v1/metrics/history/chart")
async def metrics_history_chart(
    asset_id: str = Query(..., description="Asset ID"),
    metric: str = Query("cpu", description="cpu|mem|disk|swap"),
    hours: int = Query(24, ge=1, le=168, description="Hours to show"),
    session: Session = Depends(get_session),
):
    """Get time-series data for charting."""
    from datetime import timedelta
    from .models import MetricsHistory

    start = datetime.now(UTC) - timedelta(hours=hours)
    records = (
        session.query(MetricsHistory)
        .filter(
            MetricsHistory.asset_id == asset_id,
            MetricsHistory.collected_at >= start,
        )
        .order_by(MetricsHistory.collected_at.asc())
        .all()
    )

    data = []
    for r in records:
        if metric == "cpu":
            val = r.cpu_percent
        elif metric == "mem":
            val = r.mem_percent
        elif metric == "disk":
            val = r.disk_percent
        elif metric == "swap":
            val = r.swap_percent
        else:
            val = r.cpu_percent
        data.append({
            "t": r.collected_at.isoformat(),
            "v": val,
        })

    return {"asset_id": asset_id, "metric": metric, "hours": hours, "data": data}


@app.get("/api/v1/hosts/services", response_model=RemoteAllServicesResponse)
async def hosts_services(
    session: Session = Depends(get_session),
    cache: bool = Query(False, description="Use cached results if available"),
) -> RemoteAllServicesResponse:
    """Detect running services on all SSH-configured hosts (parallel)."""
    cache_key = "hosts_services"
    if cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()

    async def _detect(asset: Asset) -> RemoteHostServicesResponse:
        port = asset.ssh_port or 22
        svcs = await asyncio.to_thread(
            detect_remote_services,
            host=asset.ssh_host,  # type: ignore[arg-type]
            port=port,
            user=asset.ssh_user,  # type: ignore[arg-type]
            asset_id=asset.id,
            name=asset.name,
            timeout=60,
        )
        return RemoteHostServicesResponse(
            asset_id=asset.id,
            name=asset.name,
            hostname=asset.ssh_host or "",
            reachable=len(svcs) > 0,
            services=[RemoteServiceResponse(**s.__dict__) for s in svcs],
        )

    hosts = await asyncio.gather(*[_detect(a) for a in assets])
    result = RemoteAllServicesResponse(hosts=list(hosts), collected_at=datetime.now(UTC).isoformat())
    _cache_set(cache_key, result)
    return result


# ── Supervisor process management endpoints ──────────────────────────────────

@app.get("/api/v1/supervisor/status", response_model=SupervisorAllStatusResponse)
async def supervisor_all_status(
    session: Session = Depends(get_session),
    cache: bool = Query(False, description="Use cached results if available"),
) -> SupervisorAllStatusResponse:
    """Get supervisor process status for all SSH-configured hosts (parallel)."""
    cache_key = "supervisor_status"
    if cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()

    async def _get_status(asset: Asset) -> SupervisorHostStatusResponse:
        port = asset.ssh_port or 22
        local = getattr(asset, "local_machine", False)
        try:
            procs = await asyncio.to_thread(
                supervisor_status,
                host=asset.ssh_host,  # type: ignore[arg-type]
                port=port,
                user=asset.ssh_user,  # type: ignore[arg-type]
                local_machine=local,
                timeout=30,
            )
            return SupervisorHostStatusResponse(
                asset_id=asset.id,
                name=asset.name,
                hostname=asset.ssh_host or "",
                reachable=len(procs) > 0,
                processes=[
                    SupervisorProcessResponse(**p.__dict__) for p in procs
                ],
            )
        except Exception as e:
            return SupervisorHostStatusResponse(
                asset_id=asset.id,
                name=asset.name,
                hostname=asset.ssh_host or "",
                reachable=False,
                error=str(e),
                processes=[],
            )

    hosts = await asyncio.gather(*[_get_status(a) for a in assets])
    result = SupervisorAllStatusResponse(
        hosts=list(hosts),
        collected_at=datetime.now(UTC).isoformat(),
    )
    _cache_set(cache_key, result)
    return result


@app.post("/api/v1/supervisor/action", response_model=SupervisorActionResponse)
def supervisor_process_action(
    req: SupervisorActionRequest,
    session: Session = Depends(get_session),
) -> SupervisorActionResponse:
    """Execute a supervisor action (start/stop/restart/signal) on a remote host."""
    asset = session.scalar(select(Asset).where(Asset.id == req.asset_id))
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.ssh_host is None or asset.ssh_user is None:
        raise HTTPException(status_code=400, detail="Asset has no SSH configuration")

    valid_actions = {"start", "stop", "restart", "signal"}
    if req.action not in valid_actions:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid action. Must be one of: {', '.join(sorted(valid_actions))}",
        )

    port = asset.ssh_port or 22
    local = getattr(asset, "local_machine", False)
    result = supervisor_action(
        host=asset.ssh_host,
        port=port,
        user=asset.ssh_user,
        action=req.action,
        process=req.process,
        signal=req.signal,
        local_machine=local,
        timeout=30,
    )
    return SupervisorActionResponse(**result.__dict__)


@app.post("/api/v1/supervisor/tail", response_model=SupervisorTailResponse)
def supervisor_process_tail(
    req: SupervisorTailRequest,
    session: Session = Depends(get_session),
) -> SupervisorTailResponse:
    """Tail the log output of a supervisor-managed process on a remote host."""
    asset = session.scalar(select(Asset).where(Asset.id == req.asset_id))
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.ssh_host is None or asset.ssh_user is None:
        raise HTTPException(status_code=400, detail="Asset has no SSH configuration")

    if req.log_type not in ("stdout", "stderr", "all"):
        raise HTTPException(status_code=400, detail="log_type must be 'stdout', 'stderr', or 'all'")

    port = asset.ssh_port or 22
    local = getattr(asset, "local_machine", False)
    result = supervisor_tail(
        host=asset.ssh_host,
        port=port,
        user=asset.ssh_user,
        process=req.process,
        log_type=req.log_type,
        lines=req.lines,
        local_machine=local,
        timeout=30,
    )
    sources_resp = [
        SupervisorLogSourceResponse(**s.__dict__) for s in result.sources
    ]
    return SupervisorTailResponse(
        process=result.process,
        lines=result.lines,
        truncated=result.truncated,
        sources=sources_resp,
    )


# ── WebSocket SSH terminal ───────────────────────────────────────────────────

logger_webssh = logging.getLogger("webssh")


@app.websocket("/ws/ssh/{asset_id}")
async def websocket_ssh(ws: WebSocket, asset_id: str):
    """WebSocket endpoint for interactive SSH terminal.

    Query params: cols (default 80), rows (default 24), token (JWT bearer)
    """
    # Validate JWT token before accepting
    token = ws.query_params.get("token", "")
    username = decode_ws_token(token)
    if username is None:
        await ws.accept()
        await ws.send_json({"type": "error", "message": "Unauthorized: invalid or missing token"})
        await ws.close()
        return

    await ws.accept()

    # Resolve asset
    with SessionLocal() as session:
        asset = session.scalar(select(Asset).where(Asset.id == asset_id))

    if asset is None:
        await ws.send_json({"type": "error", "message": "Asset not found"})
        await ws.close()
        return

    if asset.ssh_host is None or asset.ssh_user is None:
        await ws.send_json({"type": "error", "message": "Asset has no SSH configuration"})
        await ws.close()
        return

    # Parse query params for terminal size
    cols = int(ws.query_params.get("cols", "80"))
    rows = int(ws.query_params.get("rows", "24"))

    logger_webssh.info("WebSSH session: %s@%s:%d (%s)", asset.ssh_user, asset.ssh_host, asset.ssh_port or 22, asset.name)

    # Local machine assets: use local SSH to 127.0.0.1
    local = getattr(asset, "local_machine", False)
    if local:
        await webssh.handle_webssh(
            ws,
            host="127.0.0.1",
            port=22,
            user=asset.ssh_user,
            cols=cols,
            rows=rows,
            local_machine=True,
        )
    else:
        await webssh.handle_webssh(
            ws,
            host=asset.ssh_host,
            port=asset.ssh_port or 22,
            user=asset.ssh_user,
            cols=cols,
            rows=rows,
            local_machine=False,
        )

    try:
        await ws.close()
    except Exception:
        pass


from uuid import uuid4
from sqlalchemy import or_

# ── Notes CRUD ────────────────────────────────────────────────────────────────

def _parse_tags(tags_raw: str) -> list[str]:
    """Parse tags JSON string into list."""
    try:
        import json

        return json.loads(tags_raw)
    except Exception:
        return []


def _serialize_tags(tags: list[str]) -> str:
    """Serialize tags list to JSON string."""
    import json

    return json.dumps(tags, ensure_ascii=False)


def _to_note_response(note: Note) -> NoteResponse:
    """Convert Note ORM model to NoteResponse, parsing tags from JSON string."""
    d = note.__dict__.copy()
    d.pop("tags", None)
    d["tags"] = _parse_tags(note.tags)
    return NoteResponse(**d)


@app.post("/api/v1/notes", response_model=NoteResponse)
async def create_note(note_in: NoteCreate, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    now = datetime.now(UTC).replace(microsecond=0)
    note = Note(
        id=note_in.title[:32].replace(" ", "-") + str(uuid4())[:8],
        title=note_in.title,
        category=note_in.category,
        content=note_in.content,
        tags=_serialize_tags(note_in.tags),
        author=user.username,
        pinned=note_in.pinned,
        published=note_in.published,
        created_at=now,
        updated_at=now,
    )
    session.add(note)
    session.commit()
    session.refresh(note)
    from .rag_sync import sync_note
    sync_note(note)
    return _to_note_response(note)


@app.get("/api/v1/notes", response_model=NoteListResponse)
async def list_notes(
    page: int = 1,
    page_size: int = 50,
    category: str | None = None,
    search: str | None = None,
    session: Session = Depends(get_session),
):
    q = session.query(Note)
    if category:
        q = q.filter(Note.category == category)
    if search:
        pattern = f"%{search}%"
        q = q.filter(
            or_(
                Note.title.ilike(pattern),
                Note.content.ilike(pattern),
            )
        )
    total = q.count()
    items = (
        q.order_by(Note.pinned.desc(), Note.updated_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return NoteListResponse(
        items=[_to_note_response(n) for n in items],
        total=total,
        page=page,
        page_size=page_size,
        generated_at=datetime.now(UTC).replace(microsecond=0),
    )


@app.get("/api/v1/notes/{note_id}", response_model=NoteResponse)
async def get_note(note_id: str, session: Session = Depends(get_session)):
    note = session.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return _to_note_response(note)


@app.put("/api/v1/notes/{note_id}", response_model=NoteResponse)
async def update_note(
    note_id: str,
    note_in: NoteUpdate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    note = session.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    update_data = note_in.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        if value is not None:
            if key == "tags":
                setattr(note, key, _serialize_tags(value))
            else:
                setattr(note, key, value)

    note.version += 1
    note.updated_at = datetime.now(UTC).replace(microsecond=0)
    session.commit()
    session.refresh(note)
    from .rag_sync import sync_note
    sync_note(note)
    return _to_note_response(note)


@app.delete("/api/v1/notes/{note_id}")
async def delete_note(note_id: str, session: Session = Depends(get_session)):
    note = session.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    session.delete(note)
    session.commit()
    from .rag_sync import delete_source
    delete_source("note", note_id)
    return {"ok": True}


@app.post("/api/v1/notes/import-localstorage")
async def import_localstorage_notes(
    notes_data: list[NoteCreate],
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Import notes from browser localStorage to SQLite."""
    imported = 0
    imported_notes: list[Note] = []
    for n in notes_data:
        existing = session.query(Note).filter(Note.id == n.title[:32].replace(" ", "-")[:64]).first()
        if not existing:
            now = datetime.now(UTC).replace(microsecond=0)
            note = Note(
                id=n.title[:32].replace(" ", "-") + str(uuid4())[:8],
                title=n.title,
                category=n.category,
                content=n.content,
                tags=_serialize_tags(n.tags),
                author=user.username,
                pinned=n.pinned,
                published=n.published,
                created_at=now,
                updated_at=now,
            )
            session.add(note)
            imported_notes.append(note)
            imported += 1
    session.commit()
    from .rag_sync import sync_note
    for note in imported_notes:
        sync_note(note)
    return {"imported": imported}


# ── ExecLog API ───────────────────────────────────────────────────────────────

@app.get("/api/v1/exec-log", response_model=ExecLogListResponse)
async def list_exec_log(
    page: int = 1,
    page_size: int = 50,
    asset_id: str | None = None,
    session: Session = Depends(get_session),
):
    q = session.query(ExecLog)
    if asset_id:
        q = q.filter(ExecLog.asset_id == asset_id)
    total = q.count()
    items = q.order_by(ExecLog.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return ExecLogListResponse(
        items=[ExecLogResponse(**e.__dict__) for e in items],
        total=total,
        page=page,
        page_size=page_size,
        generated_at=datetime.now(UTC).replace(microsecond=0),
    )


# ── Workflow endpoints ──────────────────────────────────────────────────────


def _safe_result_json(val: str | None) -> list[dict]:
    """Parse result_json safely — always returns a list."""
    if not val:
        return []
    try:
        data = json.loads(val)
        if isinstance(data, list):
            return data
        return []
    except (json.JSONDecodeError, TypeError):
        return []


@app.get("/api/v1/workflows/templates", response_model=WorkflowTemplateListResponse)
def list_workflow_templates(session: Session = Depends(get_session)) -> WorkflowTemplateListResponse:
    items = session.query(WorkflowTemplate).filter(WorkflowTemplate.is_active == True).all()
    return WorkflowTemplateListResponse(
        items=[WorkflowTemplateResponse(
            id=t.id, name=t.name, description=t.description,
            parameters=json.loads(t.parameters_schema),
            steps=json.loads(t.steps_json),
            is_active=t.is_active,
            created_at=t.created_at, updated_at=t.updated_at,
        ) for t in items],
        total=len(items),
    )


@app.get("/api/v1/workflows/templates/{template_id}", response_model=WorkflowTemplateResponse)
def get_workflow_template(
    template_id: str,
    session: Session = Depends(get_session),
) -> WorkflowTemplateResponse:
    tpl = session.query(WorkflowTemplate).filter(WorkflowTemplate.id == template_id).first()
    if tpl is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return WorkflowTemplateResponse(
        id=tpl.id, name=tpl.name, description=tpl.description,
        parameters=json.loads(tpl.parameters_schema),
        steps=json.loads(tpl.steps_json),
        is_active=tpl.is_active,
        created_at=tpl.created_at, updated_at=tpl.updated_at,
    )


@app.post("/api/v1/workflows/templates", response_model=WorkflowTemplateResponse)
def create_workflow_template(
    tpl: WorkflowTemplateCreate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> WorkflowTemplateResponse:
    tpl_id = tpl.id or f"wf-{uuid4().hex[:12]}"
    now = datetime.now(UTC).replace(microsecond=0)
    existing = session.query(WorkflowTemplate).filter(WorkflowTemplate.id == tpl_id).first()
    if existing:
        raise HTTPException(status_code=409, detail="Template already exists")
    session.add(WorkflowTemplate(
        id=tpl_id, name=tpl.name, description=tpl.description,
        parameters_schema=json.dumps([p.model_dump() for p in tpl.parameters], ensure_ascii=False),
        steps_json=json.dumps([s.model_dump() for s in tpl.steps], ensure_ascii=False),
        is_active=tpl.is_active,
        created_at=now, updated_at=now,
    ))
    session.commit()
    return WorkflowTemplateResponse(
        id=tpl_id, name=tpl.name, description=tpl.description,
        parameters=tpl.parameters, steps=tpl.steps,
        is_active=tpl.is_active, created_at=now, updated_at=now,
    )


@app.patch("/api/v1/workflows/templates/{template_id}", response_model=WorkflowTemplateResponse)
def update_workflow_template(
    template_id: str,
    tpl: WorkflowTemplateUpdate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> WorkflowTemplateResponse:
    existing = session.query(WorkflowTemplate).filter(WorkflowTemplate.id == template_id).first()
    if existing is None:
        raise HTTPException(status_code=404, detail="Template not found")
    now = datetime.now(UTC).replace(microsecond=0)
    update_data = tpl.model_dump(exclude_unset=True)
    if "name" in update_data:
        existing.name = update_data["name"]
    if "description" in update_data:
        existing.description = update_data["description"]
    if "parameters" in update_data:
        existing.parameters_schema = json.dumps(update_data["parameters"], ensure_ascii=False)
    if "steps" in update_data:
        existing.steps_json = json.dumps(update_data["steps"], ensure_ascii=False)
    if "is_active" in update_data:
        existing.is_active = update_data["is_active"]
    existing.updated_at = now
    session.commit()
    return WorkflowTemplateResponse(
        id=existing.id, name=existing.name, description=existing.description,
        parameters=json.loads(existing.parameters_schema),
        steps=json.loads(existing.steps_json),
        is_active=existing.is_active,
        created_at=existing.created_at, updated_at=existing.updated_at,
    )


@app.delete("/api/v1/workflows/templates/{template_id}", status_code=204)
def delete_workflow_template(
    template_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    existing = session.query(WorkflowTemplate).filter(WorkflowTemplate.id == template_id).first()
    if existing is None:
        raise HTTPException(status_code=404, detail="Template not found")
    existing.is_active = False
    existing.updated_at = datetime.now(UTC).replace(microsecond=0)
    session.commit()
    return None


@app.post("/api/v1/workflows/run")
async def run_workflow_endpoint(
    req: WorkflowRunRequest,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    template = session.query(WorkflowTemplate).filter(
        WorkflowTemplate.id == req.template_id,
        WorkflowTemplate.is_active == True,
    ).first()
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found or inactive")

    token = create_access_token(data={"sub": user.username})
    execution = await run_workflow(template, req.parameters, user.username, session, auth_token=token)
    return WorkflowExecutionResponse(
        id=execution.id,
        template_id=execution.template_id,
        parameters=json.loads(execution.parameters_json),
        status=execution.status,
        result=_safe_result_json(execution.result_json),
        error=execution.error,
        user=execution.user,
        started_at=execution.started_at,
        completed_at=execution.completed_at,
    )


@app.get("/api/v1/workflows/executions", response_model=WorkflowExecutionListResponse)
def list_workflow_executions(
    template_id: str | None = None,
    status: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> WorkflowExecutionListResponse:
    q = session.query(WorkflowExecution)
    if template_id:
        q = q.filter(WorkflowExecution.template_id == template_id)
    if status:
        q = q.filter(WorkflowExecution.status == status)
    total = q.count()
    items = q.order_by(WorkflowExecution.started_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return WorkflowExecutionListResponse(
        items=[WorkflowExecutionResponse(
            id=e.id, template_id=e.template_id,
            parameters=json.loads(e.parameters_json),
            status=e.status,
            result=_safe_result_json(e.result_json),
            error=e.error, user=e.user,
            started_at=e.started_at, completed_at=e.completed_at,
        ) for e in items],
        total=total,
    )


@app.get("/api/v1/workflows/executions/{execution_id}", response_model=WorkflowExecutionDetailResponse)
def get_workflow_execution_detail(
    execution_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> WorkflowExecutionDetailResponse:
    execution = session.query(WorkflowExecution).filter(WorkflowExecution.id == execution_id).first()
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")

    template = session.query(WorkflowTemplate).filter(WorkflowTemplate.id == execution.template_id).first()
    template_name = template.name if template else execution.template_id

    steps = []
    for sr in _safe_result_json(execution.result_json):
        steps.append(ExecutionStepResult(
            step=sr.get("step", ""),
            status=sr.get("status", ""),
            result=sr.get("result", {}),
            error=sr.get("error"),
            started_at=sr.get("started_at"),
            completed_at=sr.get("completed_at"),
        ))

    duration = 0.0
    if execution.started_at and execution.completed_at:
        delta = execution.completed_at - execution.started_at
        duration = delta.total_seconds()

    return WorkflowExecutionDetailResponse(
        id=execution.id,
        template_id=execution.template_id,
        template_name=template_name,
        parameters=json.loads(execution.parameters_json),
        status=execution.status,
        steps=steps,
        error=execution.error,
        user=execution.user,
        started_at=execution.started_at,
        completed_at=execution.completed_at,
        duration_seconds=duration,
    )


# ── Agent endpoints ─────────────────────────────────────────────────────────

@app.get("/api/v1/agent/health", response_model=AgentHealthResponse)
async def agent_health(_: User = Depends(get_current_user)):
    """Check LLM API health."""
    return await agent_service.check_llm_health()


@app.get("/api/v1/agent/conversations", response_model=AgentConversationListResponse)
def agent_list_conversations(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AgentConversationListResponse:
    """List all conversations for the current user."""
    return agent_service.list_conversations(session, user.username, limit=limit, offset=offset)


@app.post("/api/v1/agent/conversations", response_model=AgentConversationResponse)
def agent_create_conversation(
    body: AgentConversationCreate | None = None,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AgentConversationResponse:
    """Create a new conversation."""
    model = body.model if body and body.model else agent_service.DEFAULT_MODEL
    return agent_service.create_conversation(session, user.username, model)


@app.delete("/api/v1/agent/conversations/{conversation_id}", status_code=204)
def agent_delete_conversation(
    conversation_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Delete a conversation and all its messages."""
    ok = agent_service.delete_conversation(session, conversation_id, user.username)
    if not ok:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return None


@app.get("/api/v1/agent/conversations/{conversation_id}/messages", response_model=AgentMessagesListResponse)
def agent_get_messages(
    conversation_id: str,
    limit: int = Query(default=100, ge=1, le=200),
    before_id: int | None = Query(default=None, ge=1),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AgentMessagesListResponse:
    """Get messages for a conversation."""
    # Verify ownership
    conv = session.query(AgentConversation).filter(
        AgentConversation.id == conversation_id,
        AgentConversation.user == user.username,
    ).first()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return agent_service.get_messages(session, conversation_id, limit=limit, before_id=before_id)


@app.post("/api/v1/agent/chat")
async def agent_chat(
    req: AgentChatRequest,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """Chat with the agent — returns SSE stream."""
    return StreamingResponse(
        agent_service.chat_stream(session, req, user.username, user.role),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/v1/agent/runs")
def agent_list_runs(limit: int = Query(default=50, ge=1, le=100), session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    """List recoverable Agent runs for the authenticated user."""
    runs = session.scalars(select(AgentRun).where(AgentRun.user == user.username).order_by(AgentRun.created_at.desc()).limit(limit)).all()
    return {"runs": [_agent_run_payload(run) for run in runs]}


def _agent_run_payload(run: AgentRun) -> dict[str, Any]:
    return {"id": run.id, "conversation_id": run.conversation_id, "status": run.status, "input": run.input, "output": run.output, "error": run.error, "cancel_requested": run.cancel_requested, "created_at": run.created_at.isoformat(), "updated_at": run.updated_at.isoformat()}


@app.get("/api/v1/agent/runs/{run_id}")
def agent_get_run(run_id: str, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    run = session.scalar(select(AgentRun).where(AgentRun.id == run_id, AgentRun.user == user.username))
    if run is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    payload = _agent_run_payload(run)
    steps = session.scalars(select(AgentStep).where(AgentStep.run_id == run.id).order_by(AgentStep.sequence, AgentStep.id)).all()
    payload["steps"] = [{"id": step.id, "sequence": step.sequence, "status": step.status, "tool_name": step.tool_name, "input": step.input, "output": step.output, "created_at": step.created_at.isoformat(), "updated_at": step.updated_at.isoformat()} for step in steps]
    return payload


@app.post("/api/v1/agent/runs/{run_id}/cancel")
def agent_cancel_run(run_id: str, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    run = session.scalar(select(AgentRun).where(AgentRun.id == run_id, AgentRun.user == user.username))
    if run is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    if run.status in {"succeeded", "failed", "cancelled", "timed_out"}:
        raise HTTPException(status_code=409, detail="Agent run is already finished")
    run.cancel_requested = True
    run.updated_at = datetime.now(UTC)
    session.commit()
    return {"ok": True, "run_id": run.id, "status": "cancelling"}


# ── Agent proactive inspection ──────────────────────────────────────────────


@app.post("/api/v1/agent/inspect", response_model=AgentInspectReport)
async def agent_inspect(
    req: AgentInspectRequest,
    user: User = Depends(get_current_user),
) -> AgentInspectReport:
    """Proactive system health inspection. Collects data, analyzes with LLM, returns report."""
    from .agent_schemas import AgentInspectRequest
    from .agent import inspect_system

    if req.create_notes and user.role != "admin":
        raise HTTPException(status_code=403, detail="Creating inspection notes requires admin role")
    report = await inspect_system(req.model, create_notes=req.create_notes, actor=user.username)
    return report


# ── Agent tool confirmation ──────────────────────────────────────────────────

# In-memory store for pending confirmations: key = confirm_id, value = asyncio.Future[bool] + result dict
_confirm_store: dict[str, tuple[Any, dict[str, Any]]] = {}


@app.post("/api/v1/agent/confirm")
async def agent_confirm(
    req: AgentConfirmRequest,
    current_user: User = Depends(get_current_user),
):
    """Frontend confirms or rejects a tool execution request."""
    entry = _confirm_store.get(req.confirm_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Confirmation request expired or not found")

    future, metadata = entry
    if metadata.get("user") != current_user.username:
        raise HTTPException(status_code=403, detail="Confirmation request belongs to another user")

    _confirm_store.pop(req.confirm_id, None)
    metadata["approved"] = req.approved
    if not future.done():
        future.set_result(req.approved)
    return {"status": "ok"}


# ── Agent usage tracking ─────────────────────────────────────────────────────

@app.get("/api/v1/agent/usage")
def get_agent_usage(
    period: Literal["today", "week", "month", "all"] = "month",
    user: str | None = None,
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    current_user: dict = Depends(get_current_user),
):
    """Get agent token usage statistics.

    period: today | week | month | all
    user: optional filter (admin can view all users)
    """
    from sqlalchemy import func
    from .models import AgentUsage
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "week":
        start = now - timedelta(days=7)
    elif period == "month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start = None  # all time

    query = select(AgentUsage)
    if start:
        query = query.where(AgentUsage.created_at >= start)

    # Non-admin can only see their own usage
    if current_user.role != "admin":
        query = query.where(AgentUsage.user == current_user.username)
    elif user:
        query = query.where(AgentUsage.user == user)

    records = session.scalars(query.order_by(AgentUsage.created_at.desc())).all()

    # Aggregate stats
    total_prompt = sum(r.prompt_tokens for r in records)
    total_completion = sum(r.completion_tokens for r in records)
    total_all = sum(r.total_tokens for r in records)
    total_tools = sum(r.tool_calls_count for r in records)

    # Per-user breakdown (for admin)
    user_breakdown = {}
    if current_user.role == "admin":
        user_agg = session.execute(
            select(
                AgentUsage.user,
                func.sum(AgentUsage.total_tokens).label("tokens"),
                func.sum(AgentUsage.tool_calls_count).label("tools"),
                func.count().label("requests"),
            ).where(
                AgentUsage.created_at >= start if start else AgentUsage.created_at >= datetime(2000, 1, 1)
            ).group_by(AgentUsage.user)
        ).all()
        for row in user_agg:
            user_breakdown[row.user] = {
                "total_tokens": row.tokens or 0,
                "tool_calls": row.tools or 0,
                "requests": row.requests,
            }

    # Per-day breakdown
    daily = {}
    for r in records:
        day = r.created_at.strftime("%Y-%m-%d")
        if day not in daily:
            daily[day] = {"date": day, "total_tokens": 0, "requests": 0, "tool_calls": 0}
        daily[day]["total_tokens"] += r.total_tokens
        daily[day]["requests"] += 1
        daily[day]["tool_calls"] += r.tool_calls_count

    return {
        "period": period,
        "total_prompt_tokens": total_prompt,
        "total_completion_tokens": total_completion,
        "total_tokens": total_all,
        "total_tool_calls": total_tools,
        "total_requests": len(records),
        "user_breakdown": user_breakdown,
        "daily": list(daily.values()),
        "records_total": len(records),
        "records_offset": offset,
        "records_limit": limit,
        "records": [
            {
                "id": r.id,
                "user": r.user,
                "conversation_id": r.conversation_id,
                "model": r.model,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "total_tokens": r.total_tokens,
                "tool_calls_count": r.tool_calls_count,
                "created_at": r.created_at.isoformat(),
            }
            for r in records[offset:offset + limit]
        ],
    }


@app.get("/api/v1/agent/memories")
def get_agent_memories(
    category: str | None = None,
    q: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    current_user: dict = Depends(get_current_user),
):
    """Get agent memories for current user, optionally filtered by category or search query."""
    from .models import AgentMemory

    sq = select(AgentMemory).where(AgentMemory.user == current_user.username)
    if category:
        sq = sq.where(AgentMemory.category == category)
    if q:
        sq = sq.where(
            (AgentMemory.key.ilike(f"%{q}%")) |
            (AgentMemory.value.ilike(f"%{q}%"))
        )
    total = session.scalar(select(func.count()).select_from(sq.subquery())) or 0
    memories = session.scalars(sq.order_by(AgentMemory.updated_at.desc()).offset(offset).limit(limit)).all()
    return {
        "memories": [
            {
                "id": m.id,
                "category": m.category,
                "key": m.key,
                "value": m.value,
                "created_at": m.created_at.isoformat(),
                "updated_at": m.updated_at.isoformat(),
            }
            for m in memories
        ],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


@app.post("/api/v1/agent/memories")
def save_agent_memory(
    req: AgentMemoryUpsert,
    session: Session = Depends(get_session),
    current_user: dict = Depends(get_current_user),
):
    """Save or update an agent memory."""
    from .models import AgentMemory
    from datetime import UTC, datetime

    key = req.key
    value = req.value
    category = req.category

    existing = session.scalar(
        select(AgentMemory).where(
            AgentMemory.user == current_user.username,
            AgentMemory.key == key,
        )
    )
    now = datetime.now(UTC)
    if existing:
        memory = existing
        memory.value = value
        memory.category = category
        memory.updated_at = now
    else:
        memory = AgentMemory(
            user=current_user.username,
            category=category,
            key=key,
            value=value,
            created_at=now,
            updated_at=now,
        )
        session.add(memory)
    session.flush()
    session.commit()
    from .rag_sync import sync_memory
    sync_memory(memory)
    return {"ok": True, "key": key}


@app.delete("/api/v1/agent/memories/{memory_id}")
def delete_agent_memory(
    memory_id: int,
    session: Session = Depends(get_session),
    current_user: dict = Depends(get_current_user),
):
    """Delete an agent memory."""
    from .models import AgentMemory

    mem = session.scalar(
        select(AgentMemory).where(
            AgentMemory.id == memory_id,
            AgentMemory.user == current_user.username,
        )
    )
    if not mem:
        raise HTTPException(status_code=404, detail="Memory not found")
    session.delete(mem)
    session.commit()
    from .rag_sync import delete_source
    delete_source("memory", str(memory_id))
    return {"ok": True}


# ── Code browser ──────────────────────────────────────────────────────────────
# 程式碼瀏覽器功能：讓使用者在 OPS 控制系統中直接瀏覽專案原始碼
# 提供兩個 API：
#   GET /api/v1/code/tree      — 掃描專案目錄，回傳遞迴檔案樹
#   GET /api/v1/code/file/{p}  — 讀取單一檔案內容，支援語法著色

# 專案根目錄 = ops-control-system/（main.py 的祖父目錄）
_PROJECT_ROOT = Path(__file__).resolve().parents[2]

# 排除的檔案副檔名（編譯產物、二進位檔、快取）
_EXCLUDED_PATTERNS = {".pyc", ".pyo", ".so", ".egg-info", "__pycache__", ".git"}
# 排除的目錄名稱（虛擬環境、依賴、建構產物、測試快取）
_EXCLUDED_DIRS = {".git", ".venv", "node_modules", "dist", ".data", ".pytest_cache", ".next", ".mypy_cache"}
# 單一檔案最大 256KB，避免載入過大的二進位檔或壓縮檔
_MAX_FILE_SIZE = 256 * 1024  # 256KB max


def _should_exclude(name: str) -> bool:
    """判斷檔案/目錄名稱是否應該排除在檔案樹之外。"""
    return name in _EXCLUDED_DIRS or any(name.endswith(p) for p in _EXCLUDED_PATTERNS)


def _build_tree(directory: Path) -> list[CodeTreeItem]:
    """遞迴掃描目錄，建構完整的檔案樹結構。

    遍歷目錄下所有檔案和子目錄，排除 _EXCLUDED_DIRS 和 _EXCLUDED_PATTERNS。
    資料夾節點會遞迴展開其子內容，檔案節點包含大小資訊。
    """
    items: list[CodeTreeItem] = []
    for entry in sorted(directory.iterdir()):
        name = entry.name
        if _should_exclude(name):
            continue
        rel = str(entry.relative_to(_PROJECT_ROOT))
        if entry.is_dir():
            # 遞迴處理子目錄
            children = _build_tree(entry)
            items.append(CodeTreeItem(name=name, path=rel, type="dir", children=children))
        else:
            # 檔案節點：取得大小，讀取失敗時設為 0
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            items.append(CodeTreeItem(name=name, path=rel, type="file", size=size))
    return items


def _count_tree(items: list[CodeTreeItem]) -> tuple[int, int]:
    """遞迴計算檔案樹中的檔案總數和資料夾總數。

    回傳 (檔案數, 資料夾數)，用於前端顯示統計資訊。
    """
    files = dirs = 0
    for item in items:
        if item.type == "dir":
            dirs += 1
            fc, dc = _count_tree(item.children)
            files += fc
            dirs += dc
        else:
            files += 1
    return files, dirs


def _detect_language(path: str) -> str:
    """根據檔案副檔名偵測程式語言，回傳 Prism.js 可用的語言名稱。

    前端使用 Prism.js 進行語法著色，此函數提供語言映射。
    未知副檔名預設回傳 "text"（純文字）。
    """
    ext_map = {
        ".py": "python", ".ts": "typescript", ".tsx": "typescript", ".js": "javascript",
        ".jsx": "javascript", ".html": "html", ".css": "css", ".json": "json",
        ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".md": "markdown",
        ".sh": "bash", ".bash": "bash", ".xml": "xml", ".sql": "sql",
        ".txt": "text", ".conf": "ini", ".env": "bash", ".log": "text",
        ".csv": "csv", ".cfg": "ini", ".ini": "ini",
        ".toml": "toml", ".lock": "text",
    }
    for ext, lang in ext_map.items():
        if path.endswith(ext):
            return lang
    return "text"


@app.get("/api/v1/code/tree", response_model=CodeTreeResponse)
def get_code_tree() -> CodeTreeResponse:
    """掃描專案根目錄，回傳完整的檔案樹結構與統計資訊。

    前端呼叫此 API 初始化檔案瀏覽器，顯示所有檔案和資料夾的樹狀結構。
    """
    tree = _build_tree(_PROJECT_ROOT)
    files, dirs = _count_tree(tree)
    return CodeTreeResponse(tree=tree, total_files=files, total_dirs=dirs)


@app.get("/api/v1/code/file/{file_path:path}", response_model=CodeFileResponse)
def get_code_file(file_path: str) -> CodeFileResponse:
    """讀取單一檔案內容，支援路徑安全檢查和語法偵測。

    安全機制:
      1. 防止路徑穿越攻擊（.. 跳脫專案目錄）
      2. 限制檔案大小（256KB）
      3. 僅支援 UTF-8 文字檔

    參數:
        file_path: 相對於專案根目錄的路徑（如 "backend/app/main.py"）
    """
    target = (_PROJECT_ROOT / file_path).resolve()
    # 安全檢查：防止路徑穿越攻擊
    if not str(target).startswith(str(_PROJECT_ROOT)):
        raise HTTPException(status_code=403, detail="Access denied: path traversal detected")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if target.stat().st_size > _MAX_FILE_SIZE:
        raise HTTPException(status_code=403, detail="File too large")
    try:
        content = target.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        raise HTTPException(status_code=400, detail="Cannot read file as text")
    return CodeFileResponse(
        path=file_path,
        content=content,
        language=_detect_language(file_path),
        line_count=len(content.splitlines()),
    )


# ── Cloud Platform APIs ──────────────────────────────────────────────────────


@app.get("/api/v1/clouds/vultr/account", response_model=VultrAccountResponse)
async def vultr_account():
    """Fetch Vultr account info with real-time balance."""
    data = await clouds_service.fetch_vultr_account()
    return VultrAccountResponse(**data)


@app.get("/api/v1/clouds/vultr/instances", response_model=VultrInstancesResponse)
async def vultr_instances():
    """Fetch Vultr instances list."""
    from datetime import datetime
    from .schemas import VultrInstanceResponse
    instances = await clouds_service.fetch_vultr_instances()
    return VultrInstancesResponse(
        instances=[VultrInstanceResponse(**i) for i in instances],
        fetched_at=datetime.now().isoformat(),
    )


@app.get("/api/v1/clouds/vultr/billing-history")
async def vultr_billing_history():
    """Fetch Vultr billing history."""
    history = await clouds_service.fetch_vultr_billing_history()
    return {"billing_history": history}


@app.get("/api/v1/clouds/conoha/instances", response_model=VultrInstancesResponse)
async def conoha_instances():
    """Fetch ConoHa VPS 3.0 instances list via OpenStack Nova API."""
    from datetime import datetime
    from .schemas import VultrInstanceResponse
    instances = await clouds_service.fetch_conoha_instances()
    return VultrInstancesResponse(
        instances=[VultrInstanceResponse(**i) for i in instances],
        fetched_at=datetime.now().isoformat(),
    )


# ── RAG Stats ──────────────────────────────────────────────────────────────

@app.get("/api/v1/agent/rag/stats")
def get_rag_stats(
    current_user: User = Depends(get_current_user),
):
    """Get RAG index statistics."""
    from .agent_rag import get_index_stats
    return get_index_stats()


@app.post("/api/v1/agent/rag/reindex")
def reindex_rag(
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """Rebuild RAG index (admin only)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="需要 admin 權限")
    from .agent_rag import build_full_index, get_index_stats
    stats = build_full_index(session)
    return {"status": "ok", "index_stats": get_index_stats(), "build_stats": stats}


@app.get("/api/v1/agent/rag/evaluation")
def evaluate_rag(
    current_user: User = Depends(get_current_user),
):
    """Evaluate multilingual Runbook retrieval without rebuilding the index."""
    from .rag_evaluation import evaluate_runbook_retrieval
    return evaluate_runbook_retrieval()


# ── ComfyUI 生成 ──────────────────────────────────────────────────────────


@app.get("/api/v1/comfyui/status", response_model=ComfyStatusResponse)
async def comfyui_status(
    current_user: User = Depends(get_current_user),
):
    """ComfyUI 健康狀態 + GPU + 佇列。"""
    return await comfyui_service.get_status()


@app.get("/api/v1/comfyui/workflows", response_model=ComfyWorkflowListResponse)
async def comfyui_workflows(
    current_user: User = Depends(get_current_user),
):
    """即時列出 ComfyUI userdata/workflows 中的所有 JSON 工作流。"""
    try:
        workflows = await comfyui_service.list_workflows()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"讀取 ComfyUI 工作流失敗：{e}")
    return {"templates": workflows}


@app.patch("/api/v1/comfyui/workflows/{workflow_id}")
async def comfyui_rename_workflow(
    workflow_id: str,
    body: ComfyWorkflowRenameRequest,
    current_user: User = Depends(get_current_user),
):
    """Rename a workflow file in ComfyUI userdata/workflows."""
    try:
        workflow = await comfyui_service.rename_workflow(workflow_id, body.name)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"重新命名工作流失敗：{exc}")
    if workflow is None:
        raise HTTPException(status_code=404, detail="工作流不存在或已從 ComfyUI 移除")
    return workflow


@app.delete("/api/v1/comfyui/workflows/{workflow_id}", status_code=204)
async def comfyui_delete_workflow(
    workflow_id: str,
    current_user: User = Depends(get_current_user),
):
    """Delete a workflow file from ComfyUI userdata/workflows."""
    try:
        deleted = await comfyui_service.delete_workflow(workflow_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"刪除工作流失敗：{exc}")
    if not deleted:
        raise HTTPException(status_code=404, detail="工作流不存在或已從 ComfyUI 移除")


@app.post("/api/v1/comfyui/generate", response_model=ComfyGenerateResponse)
async def comfyui_generate(
    body: ComfyGenerateRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """提交生成任務：注入參數 → POST ComfyUI /prompt → 記錄 ComfyJob。"""
    try:
        template = await comfyui_service.get_workflow(body.workflow_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"讀取工作流失敗：{e}")
    if not template:
        raise HTTPException(status_code=404, detail="工作流不存在或已從 ComfyUI 移除")
    if not template.get("runnable"):
        raise HTTPException(status_code=422, detail=template.get("disabled_reason") or "工作流目前無法直接執行")
    workflow = json.loads(json.dumps(template["workflow"]))
    comfyui_service.inject_params(workflow, template, body.params)
    try:
        _, unavailable_selectors = await comfyui_service.normalize_workflow_selectors_live(workflow)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"無法讀取 ComfyUI 模型清單：{exc}")
    if unavailable_selectors:
        raise HTTPException(
            status_code=422,
            detail="ComfyUI 目前找不到工作流所需模型或選項：" + "、".join(unavailable_selectors[:3]),
        )
    missing_images = []
    for node in workflow.values():
        if node.get("class_type") != "LoadImage":
            continue
        filename = str((node.get("inputs") or {}).get("image") or "")
        if filename and not (comfyui_service.COMFY_INPUT_DIR / filename).is_file():
            missing_images.append(filename)
    if missing_images:
        names = "、".join(sorted(set(missing_images)))
        raise HTTPException(status_code=422, detail=f"請先上傳工作流所需圖片：{names}")
    try:
        prompt_id = await comfyui_service.submit_workflow(workflow)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ComfyUI 提交失敗：{e}")
    job = ComfyJob(
        id=f"cf-{uuid4().hex[:12]}",
        prompt_id=prompt_id,
        workflow_id=template["id"],
        workflow_name=template.get("name", template["id"]),
        params_json=json.dumps(body.params, ensure_ascii=False),
        status="queued",
        created_by=current_user.username,
        created_at=datetime.now(UTC),
    )
    session.add(job)
    session.commit()
    return {"job_id": job.id, "prompt_id": prompt_id, "status": job.status}


def _can_manage_comfy_job(job: ComfyJob, current_user: User) -> bool:
    return current_user.role == "admin" or job.created_by == current_user.username


def _can_manage_comfy_sequence(sequence: ComfySequence, current_user: User) -> bool:
    return current_user.role == "admin" or sequence.created_by == current_user.username


def _sequence_response(sequence: ComfySequence) -> dict[str, Any]:
    return {
        "id": sequence.id,
        "title": sequence.title,
        "prompt": sequence.prompt,
        "first_frame": sequence.first_frame,
        "character_ref": sequence.character_ref,
        "background_ref": sequence.background_ref,
        "width": sequence.width,
        "height": sequence.height,
        "segment_seconds": sequence.segment_seconds,
        "total_seconds": sequence.total_seconds,
        "seed": sequence.seed,
        "status": sequence.status,
        "progress": sequence.progress,
        "current_segment": sequence.current_segment,
        "total_segments": sequence.total_segments,
        "current_prompt_id": sequence.current_prompt_id,
        "segments": json.loads(sequence.segments_json or "[]"),
        "final_output": json.loads(sequence.final_output_json) if sequence.final_output_json else None,
        "error": sequence.error,
        "created_by": sequence.created_by,
        "created_at": sequence.created_at,
        "updated_at": sequence.updated_at,
        "finished_at": sequence.finished_at,
    }


@app.post("/api/v1/comfyui/sequences", response_model=ComfySequenceResponse)
async def comfyui_create_sequence(
    body: ComfySequenceCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """建立首尾幀接力的長動畫任務。"""
    try:
        status_info = await comfyui_service.get_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"無法連線 ComfyUI：{exc}")
    if not status_info.get("online"):
        raise HTTPException(status_code=503, detail=status_info.get("error") or "ComfyUI 未啟動")

    now = datetime.now(UTC)
    sequence = ComfySequence(
        id=f"seq-{uuid4().hex[:12]}",
        title=body.title.strip(),
        prompt=body.prompt.strip(),
        first_frame=body.first_frame,
        character_ref=body.character_ref,
        background_ref=body.background_ref,
        width=body.width,
        height=body.height,
        segment_seconds=body.segment_seconds,
        total_seconds=body.total_seconds,
        seed=body.seed,
        status="queued",
        progress=0,
        current_segment=0,
        total_segments=comfyui_sequence_service.segment_count(body.total_seconds, body.segment_seconds),
        segments_json="[]",
        created_by=current_user.username,
        created_at=now,
        updated_at=now,
    )
    session.add(sequence)
    session.commit()
    session.refresh(sequence)
    response = _sequence_response(sequence)
    comfyui_sequence_service.start_sequence(sequence.id)
    return response


@app.get("/api/v1/comfyui/sequences", response_model=ComfySequenceListResponse)
def comfyui_sequences(
    limit: int = Query(30, ge=1, le=100),
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    query = select(ComfySequence).order_by(ComfySequence.created_at.desc()).limit(limit)
    sequences = session.scalars(query).all()
    return {"sequences": [_sequence_response(item) for item in sequences]}


@app.get("/api/v1/comfyui/sequences/{sequence_id}", response_model=ComfySequenceResponse)
def comfyui_sequence_detail(
    sequence_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    sequence = session.get(ComfySequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=404, detail="長動畫任務不存在")
    return _sequence_response(sequence)


@app.post("/api/v1/comfyui/sequences/{sequence_id}/cancel")
async def comfyui_cancel_sequence(
    sequence_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    sequence = session.get(ComfySequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=404, detail="長動畫任務不存在")
    if not _can_manage_comfy_sequence(sequence, current_user):
        raise HTTPException(status_code=403, detail="無權管理此任務")
    if sequence.status not in ("queued", "running", "stitching"):
        raise HTTPException(status_code=409, detail="此任務目前無法取消")
    try:
        await comfyui_sequence_service.cancel_sequence(sequence_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"取消任務失敗：{exc}")
    return {"status": "cancelled"}


@app.delete("/api/v1/comfyui/sequences/{sequence_id}")
def comfyui_delete_sequence(
    sequence_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    sequence = session.get(ComfySequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=404, detail="長動畫任務不存在")
    if not _can_manage_comfy_sequence(sequence, current_user):
        raise HTTPException(status_code=403, detail="無權管理此任務")
    if sequence.status in ("queued", "running", "stitching"):
        raise HTTPException(status_code=409, detail="請先取消進行中的任務")
    comfyui_sequence_service.delete_sequence_files(sequence_id)
    session.delete(sequence)
    session.commit()
    return {"deleted": True}


@app.post("/api/v1/comfyui/jobs/{job_id}/cancel")
async def comfyui_cancel_job(
    job_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """取消排隊或執行中的生成任務。"""
    job = session.get(ComfyJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任務不存在")
    if not _can_manage_comfy_job(job, current_user):
        raise HTTPException(status_code=403, detail="無權管理此任務")
    if job.status not in ("queued", "running") or not job.prompt_id:
        raise HTTPException(status_code=409, detail="只有排隊或執行中的任務可以取消")
    try:
        await comfyui_service.cancel_prompt(job.prompt_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"取消 ComfyUI 任務失敗：{e}")
    job.status = "cancelled"
    job.error = "使用者取消任務"
    job.finished_at = datetime.now(UTC)
    session.commit()
    return {"status": "cancelled"}


@app.delete("/api/v1/comfyui/jobs/{job_id}/outputs/{output_index}")
def comfyui_delete_output(
    job_id: str,
    output_index: int,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """刪除單一生成作品及其資料庫引用。"""
    job = session.get(ComfyJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任務不存在")
    if not _can_manage_comfy_job(job, current_user):
        raise HTTPException(status_code=403, detail="無權管理此作品")
    outputs = json.loads(job.outputs_json or "[]")
    if output_index < 0 or output_index >= len(outputs):
        raise HTTPException(status_code=404, detail="作品不存在")
    output = outputs[output_index]
    try:
        deleted = comfyui_service.delete_output_file(output)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    outputs.pop(output_index)
    job.outputs_json = json.dumps(outputs, ensure_ascii=False)
    session.commit()
    return {"deleted": deleted, "remaining": len(outputs)}


@app.delete("/api/v1/comfyui/jobs/{job_id}")
def comfyui_delete_job(
    job_id: str,
    delete_outputs: bool = True,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """刪除生成記錄；預設一併刪除 output/temp 作品檔。"""
    job = session.get(ComfyJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任務不存在")
    if not _can_manage_comfy_job(job, current_user):
        raise HTTPException(status_code=403, detail="無權管理此任務")
    if job.status in ("queued", "running"):
        raise HTTPException(status_code=409, detail="請先取消進行中的任務")
    deleted_files = 0
    if delete_outputs:
        for output in json.loads(job.outputs_json or "[]"):
            try:
                deleted_files += int(comfyui_service.delete_output_file(output))
            except ValueError:
                continue
    session.delete(job)
    session.commit()
    return {"deleted": True, "deleted_files": deleted_files}


@app.post("/api/v1/comfyui/free")
async def comfyui_free_memory(
    current_user: User = Depends(get_current_user),
):
    """卸載 ComfyUI 模型並釋放未使用顯存。"""
    try:
        await comfyui_service.free_memory()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"釋放顯存失敗：{e}")
    return {"status": "ok"}


def _sync_comfy_artifact_index(session: Session) -> int:
    """Synchronize the persistent artifact index only when an explicit scan is requested."""
    scanned, _ = comfyui_service.list_output_artifacts(limit=100_000, refresh=True)
    seen_ids = {item["id"] for item in scanned}
    existing = {item.id: item for item in session.scalars(select(ComfyArtifactRecord)).all()}
    for item in scanned:
        record = existing.get(item["id"])
        if record is None:
            record = ComfyArtifactRecord(id=item["id"])
            session.add(record)
        record.filename = item["filename"]
        record.subfolder = item["subfolder"]
        record.kind = item["kind"]
        record.file_type = item["type"]
        record.modified_at = item["modified_at"]
        record.size_bytes = item["size_bytes"]
    for artifact_id, record in existing.items():
        if artifact_id not in seen_ids:
            session.delete(record)
    session.commit()
    return len(scanned)


def _artifact_response(record: ComfyArtifactRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "filename": record.filename,
        "subfolder": record.subfolder,
        "type": record.file_type,
        "kind": record.kind,
        "modified_at": record.modified_at,
        "size_bytes": record.size_bytes,
    }


@app.get("/api/v1/comfyui/artifacts", response_model=ComfyArtifactListResponse)
def comfyui_artifacts(
    offset: int = Query(0, ge=0),
    limit: int = Query(24, ge=1, le=100),
    refresh: bool = False,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """作品庫：正常分頁只查資料庫；首次與手動刷新才掃描 ComfyUI output。"""
    total = session.scalar(select(func.count()).select_from(ComfyArtifactRecord)) or 0
    if refresh or total == 0:
        _sync_comfy_artifact_index(session)
        total = session.scalar(select(func.count()).select_from(ComfyArtifactRecord)) or 0
    records = session.scalars(
        select(ComfyArtifactRecord)
        .order_by(ComfyArtifactRecord.modified_at.desc(), ComfyArtifactRecord.id.desc())
        .offset(offset).limit(limit)
    ).all()
    return {"artifacts": [_artifact_response(record) for record in records], "total": total, "offset": offset, "limit": limit}


@app.delete("/api/v1/comfyui/artifacts")
def comfyui_delete_artifact(
    filename: str,
    subfolder: str = "",
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """刪除作品庫中的單一 output 檔案。"""
    try:
        deleted = comfyui_service.delete_output_file({
            "filename": filename, "subfolder": subfolder, "type": "output",
        })
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not deleted:
        raise HTTPException(status_code=404, detail="作品不存在或已被刪除")
    record = session.scalar(select(ComfyArtifactRecord).where(
        ComfyArtifactRecord.filename == filename, ComfyArtifactRecord.subfolder == subfolder,
    ))
    if record is not None:
        session.delete(record)
        session.commit()
    return {"deleted": True}


@app.get("/api/v1/comfyui/jobs", response_model=ComfyJobListResponse)
def comfyui_jobs(
    limit: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """生成任務歷史（最新在前）。"""
    jobs = session.scalars(
        select(ComfyJob).order_by(ComfyJob.created_at.desc()).limit(limit)
    ).all()
    return {"jobs": [comfyui_service.job_to_response(j) for j in jobs]}


@app.get("/api/v1/comfyui/jobs/{job_id}", response_model=ComfyJobResponse)
async def comfyui_job_detail(
    job_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """任務詳情；進行中的任務會嘗試從 ComfyUI history 補齊狀態。"""
    job = session.get(ComfyJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任務不存在")
    prompt_id = job.prompt_id
    if prompt_id and job.status in ("queued", "running"):
        try:
            history = await comfyui_service.get_history(prompt_id)
            if history:
                job.status, job.error = comfyui_service.history_status(history)
                job.outputs_json = json.dumps(
                    comfyui_service.parse_outputs(history), ensure_ascii=False
                )
                job.finished_at = datetime.now(UTC)
                session.commit()
        except Exception:
            pass  # ComfyUI 可能剛重啟，維持現狀
    return comfyui_service.job_to_response(job)


@app.get("/api/v1/comfyui/jobs/{job_id}/events")
async def comfyui_job_events(
    job_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """任務進度 SSE 串流：progress / executing / done / error。"""
    job = session.get(ComfyJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任務不存在")
    if not job.prompt_id:
        raise HTTPException(status_code=400, detail="任務無 prompt_id")
    prompt_id: str = job.prompt_id

    async def event_gen():
        def _sse(payload: dict) -> str:
            return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        # 已完成的任務直接回放結果
        try:
            history = await comfyui_service.get_history(prompt_id)
        except Exception:
            history = None
        if history:
            job.status, job.error = comfyui_service.history_status(history)
            job.outputs_json = json.dumps(
                comfyui_service.parse_outputs(history), ensure_ascii=False
            )
            job.finished_at = datetime.now(UTC)
            session.commit()
            yield _sse({"event": "progress", "value": 100, "max": 100})
            if job.status == "error":
                yield _sse({"event": "error", "message": job.error or "執行失敗", "prompt_id": prompt_id})
            else:
                yield _sse({"event": "done", "prompt_id": prompt_id})
            return

        # 不在 history 也不在佇列 → ComfyUI 重啟或任務遺失，直接標錯誤
        queued_ids = await comfyui_service.get_queue_prompt_ids()
        if prompt_id not in queued_ids:
            job.status = "error"
            job.error = "ComfyUI 已重啟或任務遺失"
            job.finished_at = datetime.now(UTC)
            session.commit()
            yield _sse({"event": "error", "message": job.error, "prompt_id": prompt_id})
            return

        async for ev in comfyui_service.stream_progress(prompt_id):
            etype = ev["event"]
            if etype == "heartbeat":
                try:
                    history = await comfyui_service.get_history(prompt_id)
                except Exception:
                    history = None
                if history:
                    job.status, job.error = comfyui_service.history_status(history)
                    job.outputs_json = json.dumps(
                        comfyui_service.parse_outputs(history), ensure_ascii=False
                    )
                    job.progress = 100
                    job.finished_at = datetime.now(UTC)
                    session.commit()
                    if job.status == "error":
                        ev = {"event": "error", "message": job.error or "執行失敗", "prompt_id": prompt_id}
                    else:
                        ev = {"event": "done", "prompt_id": prompt_id}
                    yield _sse(ev)
                    return
                queue_state = await comfyui_service.get_prompt_queue_state(prompt_id)
                if queue_state:
                    job.status = queue_state[0]
                    session.commit()
                    ev.update(status=queue_state[0], queue_position=queue_state[1])
                yield _sse(ev)
                continue
            if etype == "progress":
                if ev.get("max"):
                    job.progress = min(99, round(ev["value"] * 100 / ev["max"]))
                if job.status == "queued":
                    job.status = "running"
                session.commit()
            elif etype == "executing":
                if ev.get("node"):
                    job.status = "running"
                    session.commit()
            elif etype == "done":
                job.status = "done"
                job.progress = 100
                try:
                    history = await comfyui_service.get_history(prompt_id)
                    if history:
                        job.outputs_json = json.dumps(
                            comfyui_service.parse_outputs(history), ensure_ascii=False
                        )
                except Exception:
                    pass
                job.finished_at = datetime.now(UTC)
                session.commit()
            elif etype == "error":
                job.status = "error"
                job.error = ev.get("message", "執行失敗")
                job.finished_at = datetime.now(UTC)
                session.commit()
            yield _sse(ev)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/v1/comfyui/view")
async def comfyui_view(
    filename: str,
    subfolder: str = "",
    view_type: str = "output",
    current_user: User = Depends(get_current_user),
):
    """代理 ComfyUI /view 輸出預覽（圖片/視頻/音頻）。"""
    try:
        content, ctype = await comfyui_service.fetch_view(filename, subfolder, view_type)
    except Exception:
        raise HTTPException(status_code=404, detail="檔案不存在")
    return Response(
        content=content,
        media_type=ctype,
        headers={"Cache-Control": "public, max-age=3600"},
    )



@app.post("/api/v1/comfyui/media-url")
def comfyui_media_url(
    filename: str,
    subfolder: str = "",
    view_type: str = "output",
    current_user: User = Depends(get_current_user),
):
    """Issue a short-lived URL that native media elements can load and seek."""
    try:
        comfyui_service.resolve_view_file(filename, subfolder, view_type)
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=404, detail="檔案不存在")
    token = create_access_token(
        {
            "sub": current_user.username,
            "scope": "comfyui:view",
            "filename": filename,
            "subfolder": subfolder,
            "view_type": view_type,
        },
        expires_delta=timedelta(minutes=30),
    )
    return {"url": f"/api/v1/comfyui/media?filename={quote(filename)}&subfolder={quote(subfolder)}&view_type={quote(view_type)}&token={quote(token)}"}


@app.get("/api/v1/comfyui/media")
def comfyui_media(
    filename: str,
    subfolder: str = "",
    view_type: str = "output",
    token: str = "",
):
    """Serve local Comfy output with HTTP range support for instant playback."""
    if not is_valid_comfy_media_token(token, filename, subfolder, view_type):
        raise HTTPException(status_code=401, detail="無效或過期的媒體連結")
    try:
        file_path = comfyui_service.resolve_view_file(filename, subfolder, view_type)
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=404, detail="檔案不存在")
    return FileResponse(file_path, headers={"Cache-Control": "private, max-age=1800"})


@app.post("/api/v1/comfyui/thumbnail-url")
def comfyui_thumbnail_url(
    filename: str,
    subfolder: str = "",
    view_type: str = "output",
    current_user: User = Depends(get_current_user),
):
    """Generate a compact video cover and issue a constrained URL for it."""
    try:
        comfyui_service.get_video_thumbnail(filename, subfolder, view_type)
    except (ValueError, FileNotFoundError):
        raise HTTPException(status_code=404, detail="縮圖來源不存在")
    except RuntimeError:
        raise HTTPException(status_code=422, detail="無法產生影片縮圖")
    token = create_access_token(
        {"sub": current_user.username, "scope": "comfyui:thumbnail", "filename": filename,
         "subfolder": subfolder, "view_type": view_type},
        expires_delta=timedelta(minutes=30),
    )
    return {"url": f"/api/v1/comfyui/thumbnail?filename={quote(filename)}&subfolder={quote(subfolder)}&view_type={quote(view_type)}&token={quote(token)}"}


@app.get("/api/v1/comfyui/thumbnail")
def comfyui_thumbnail(filename: str, subfolder: str = "", view_type: str = "output", token: str = ""):
    if not is_valid_comfy_media_token(token, filename, subfolder, view_type, scope="comfyui:thumbnail"):
        raise HTTPException(status_code=401, detail="無效或過期的縮圖連結")
    try:
        thumbnail = comfyui_service.get_video_thumbnail(filename, subfolder, view_type)
    except (ValueError, FileNotFoundError, RuntimeError):
        raise HTTPException(status_code=404, detail="縮圖不存在")
    return FileResponse(thumbnail, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=1800"})

@app.post("/api/v1/comfyui/upload", response_model=ComfyUploadResponse)
async def comfyui_upload(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """上傳圖片到 ComfyUI input 目錄（供圖生視頻模板使用）。"""
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="檔案過大（上限 50MB）")
    original_name = (file.filename or "image.png").replace("\\", "/").split("/")[-1]
    filename = f"{uuid4().hex[:10]}-{original_name}"
    try:
        res = await comfyui_service.upload_image(filename, data)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"上傳失敗：{e}")
    return {
        "filename": res.get("name", filename),
        "subfolder": res.get("subfolder", ""),
        "type": res.get("type", "input"),
    }


# ── Share API (public) ───────────────────────────────────────────────────────

SHARE_DATA_DIR = Path(__file__).resolve().parents[2] / ".data" / "share"
SHARE_COVERS_DIR = SHARE_DATA_DIR / "covers"
SHARE_VIDEOS_DIR = SHARE_DATA_DIR / "videos"
SHARE_COVERS_DIR.mkdir(parents=True, exist_ok=True)
SHARE_VIDEOS_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/api/v1/share/posts", response_model=SharePostListResponse)
def share_list_posts(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=12, ge=1, le=50),
    session: Session = Depends(get_session),
) -> SharePostListResponse:
    """Public: list published posts."""
    q = select(SharePost).where(SharePost.status == "published")
    total = session.scalar(select(func.count()).select_from(q.subquery())) or 0
    items = session.scalars(q.order_by(SharePost.published_at.desc(), SharePost.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return SharePostListResponse(
        items=[SharePostResponse.model_validate(p) for p in items],
        total=total,
        page=page,
        page_size=page_size,
        generated_at=datetime.now(UTC),
    )


@app.get("/api/v1/share/posts/{slug}")
def share_get_post(slug: str, session: Session = Depends(get_session)) -> SharePostResponse:
    """Public: get a single published post by slug."""
    post = session.scalar(select(SharePost).where(SharePost.slug == slug, SharePost.status == "published"))
    if post is None:
        raise HTTPException(status_code=404, detail="Post not found")
    return SharePostResponse.model_validate(post)


@app.get("/api/v1/share/posts/{slug}/video")
def share_stream_video(slug: str, range_header: str | None = None):
    """Public: stream video file with Range support."""
    # Find the post
    with SessionLocal() as session:
        post = session.scalar(select(SharePost).where(SharePost.slug == slug, SharePost.status == "published", SharePost.video_file.isnot(None)))
    if post is None:
        raise HTTPException(status_code=404, detail="Video not found")

    video_path = SHARE_VIDEOS_DIR / post.video_file  # type: ignore[operator]
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file missing")

    import re
    start, end = 0, video_path.stat().st_size - 1
    if range_header:
        m = re.search(r"bytes=(\d+)-(\d*)", range_header)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else video_path.stat().st_size - 1

    length = end - start + 1
    headers = {
        "Content-Range": f"bytes {start}-{end}/{video_path.stat().st_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Content-Type": "video/mp4",
    }

    return Response(
        content=open(video_path, "rb").seek(start) and open(video_path, "rb").read()[start:end + 1],
        status_code=206,
        headers=headers,
        media_type="video/mp4",
    )


# ── Share API (admin - JWT required) ─────────────────────────────────────────

@app.get("/api/v1/posts", response_model=SharePostListResponse)
def admin_list_posts(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=50),
    status_filter: str | None = None,
    session: Session = Depends(get_session),
    _user: User = Depends(get_current_user),
) -> SharePostListResponse:
    """Admin: list all posts (including drafts)."""
    q = select(SharePost)
    if status_filter:
        q = q.where(SharePost.status == status_filter)
    total = session.scalar(select(func.count()).select_from(q.subquery())) or 0
    items = session.scalars(q.order_by(SharePost.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return SharePostListResponse(
        items=[SharePostResponse.model_validate(p) for p in items],
        total=total,
        page=page,
        page_size=page_size,
        generated_at=datetime.now(UTC),
    )


@app.post("/api/v1/posts", response_model=SharePostResponse)
def admin_create_post(
    body: SharePostCreate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SharePostResponse:
    """Admin: create a new post."""
    existing = session.scalar(select(SharePost).where(SharePost.slug == body.slug))
    if existing:
        raise HTTPException(status_code=409, detail=f"Slug '{body.slug}' already exists")

    now = datetime.now(UTC)
    post = SharePost(
        title=body.title,
        slug=body.slug,
        cover_image=body.cover_image,
        video_file=body.video_file,
        content=body.content,
        excerpt=body.excerpt,
        status=body.status,
        author=user.username,
        created_at=now,
        updated_at=now,
        published_at=now if body.status == "published" else None,
    )
    session.add(post)
    session.commit()
    session.refresh(post)
    return SharePostResponse.model_validate(post)


@app.put("/api/v1/posts/{post_id}", response_model=SharePostResponse)
def admin_update_post(
    post_id: int,
    body: SharePostUpdate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SharePostResponse:
    """Admin: update a post."""
    post = session.scalar(select(SharePost).where(SharePost.id == post_id))
    if post is None:
        raise HTTPException(status_code=404, detail="Post not found")

    update_data = body.model_dump(exclude_unset=True)
    if "slug" in update_data:
        existing = session.scalar(select(SharePost).where(SharePost.slug == body.slug, SharePost.id != post_id))
        if existing:
            raise HTTPException(status_code=409, detail=f"Slug '{body.slug}' already exists")

    for key, value in update_data.items():
        setattr(post, key, value)
    post.updated_at = datetime.now(UTC)

    if "status" in update_data and update_data["status"] == "published" and post.status != "published":
        post.published_at = datetime.now(UTC)

    session.commit()
    session.refresh(post)
    return SharePostResponse.model_validate(post)


@app.delete("/api/v1/posts/{post_id}")
def admin_delete_post(
    post_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Admin: delete a post."""
    post = session.scalar(select(SharePost).where(SharePost.id == post_id))
    if post is None:
        raise HTTPException(status_code=404, detail="Post not found")
    session.delete(post)
    session.commit()
    return {"deleted": True, "id": post_id}


@app.patch("/api/v1/posts/{post_id}/status", response_model=SharePostResponse)
def admin_update_post_status(
    post_id: int,
    body: SharePostStatusUpdate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SharePostResponse:
    """Admin: change post status."""
    post = session.scalar(select(SharePost).where(SharePost.id == post_id))
    if post is None:
        raise HTTPException(status_code=404, detail="Post not found")
    if body.status not in ("draft", "published", "archived"):
        raise HTTPException(status_code=400, detail="Invalid status")

    old_status = post.status
    post.status = body.status
    post.updated_at = datetime.now(UTC)
    if body.status == "published" and old_status != "published":
        post.published_at = datetime.now(UTC)
    elif body.status != "published":
        post.published_at = None

    session.commit()
    session.refresh(post)
    return SharePostResponse.model_validate(post)


@app.post("/api/v1/posts/{post_id}/upload-cover", response_model=dict)
async def admin_upload_cover(
    post_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Admin: upload cover image for a post."""
    post = session.scalar(select(SharePost).where(SharePost.id == post_id))
    if post is None:
        raise HTTPException(status_code=404, detail="Post not found")

    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Cover image too large (max 20MB)")

    import uuid
    ext = (file.filename or "image.png").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "png"
    if ext not in ("jpg", "jpeg", "png", "webp", "gif"):
        ext = "png"
    filename = f"{uuid.uuid4().hex[:10]}.{ext}"
    filepath = SHARE_COVERS_DIR / filename
    filepath.write_bytes(data)

    post.cover_image = filename
    post.updated_at = datetime.now(UTC)
    session.commit()

    return {"filename": filename, "url": f"/share-static/covers/{filename}"}


class PublishFromSourceRequest(BaseModel):
    source_type: str  # "note" | "comfyui"
    source_id: str
    title: str | None = None
    excerpt: str | None = None
    cover_image: str | None = None
    status: str = "published"  # "published" | "draft"


@app.post("/api/v1/posts/publish-from-source", response_model=SharePostResponse)
def admin_publish_from_source(
    body: PublishFromSourceRequest,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SharePostResponse:
    """Admin: publish content from a note or ComfyUI artifact to the homepage."""
    if body.source_type not in ("note", "comfyui"):
        raise HTTPException(status_code=400, detail="source_type must be 'note' or 'comfyui'")

    # Check if already published from this source
    existing = session.scalar(
        select(SharePost).where(
            SharePost.source_type == body.source_type,
            SharePost.source_id == body.source_id,
        )
    )
    if existing:
        # Update existing post
        if body.title:
            existing.title = body.title
        if body.excerpt:
            existing.excerpt = body.excerpt
        if body.cover_image:
            existing.cover_image = body.cover_image
        old_status = existing.status
        existing.status = body.status
        existing.updated_at = datetime.now(UTC)
        if body.status == "published" and old_status != "published":
            existing.published_at = datetime.now(UTC)
        elif body.status != "published":
            existing.published_at = None
        session.commit()
        session.refresh(existing)
        return SharePostResponse.model_validate(existing)

    # Fetch source content
    title = body.title or ""
    content = ""
    excerpt = body.excerpt or ""

    if body.source_type == "note":
        from .models import Note
        note = session.scalar(select(Note).where(Note.id == body.source_id))
        if note is None:
            raise HTTPException(status_code=404, detail="Note not found")
        title = body.title or note.title
        content = note.content
        if not excerpt:
            # Generate excerpt from content (strip markdown, first 200 chars)
            plain = re.sub(r"[#*`>\[\]|\-]", "", content).strip()
            excerpt = plain[:200] + ("…" if len(plain) > 200 else "")
    elif body.source_type == "comfyui":
        # For ComfyUI artifacts, the content is a description/caption
        title = body.title or "AI 生成作品"
        content = body.excerpt or "AI 生成作品"
        if not excerpt:
            excerpt = content[:200]

    # Generate unique slug — keep it short and clean
    # Remove em dashes, extra spaces, and non-essential characters
    clean_title = title.replace("—", " ").replace("–", " ").replace("—", " ")
    base_slug = re.sub(r"[^\w\u4e00-\u9fff-]", "-", clean_title.lower()).strip("-")
    # Collapse multiple dashes
    base_slug = re.sub(r"-{2,}", "-", base_slug)
    # Limit to 50 chars for cleaner URLs
    base_slug = base_slug[:50].rstrip("-") or f"post-{body.source_id}"
    slug = base_slug
    counter = 1
    while session.scalar(select(SharePost).where(SharePost.slug == slug)):
        slug = f"{base_slug}-{counter}"
        counter += 1

    now = datetime.now(UTC)
    post = SharePost(
        title=title,
        slug=slug,
        cover_image=body.cover_image,
        video_file=None,
        content=content,
        excerpt=excerpt,
        status=body.status,
        author=user.username,
        source_type=body.source_type,
        source_id=body.source_id,
        created_at=now,
        updated_at=now,
        published_at=now if body.status == "published" else None,
    )
    session.add(post)
    session.commit()
    session.refresh(post)
    return SharePostResponse.model_validate(post)


# ── SPA Fallback ──────────────────────────────────────────────────────────────


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    # Serve static assets directly
    app.mount("/assets", StaticFiles(directory=str(frontend_dist / "assets")), name="frontend-assets")

    # Serve share static files (covers, videos)
    if SHARE_COVERS_DIR.is_dir():
        app.mount("/share-static/covers", StaticFiles(directory=str(SHARE_COVERS_DIR)), name="share-covers")
    if SHARE_VIDEOS_DIR.is_dir():
        app.mount("/share-static/videos", StaticFiles(directory=str(SHARE_VIDEOS_DIR)), name="share-videos")

    # SPA fallback: serve index.html for any unmatched route
    from fastapi.responses import FileResponse

    @app.get("/", response_class=FileResponse)
    async def spa_root():
        """Serve index.html for root."""
        return FileResponse(frontend_dist / "index.html")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        """Serve index.html for any unmatched route (SPA fallback)."""
        # Don't intercept API routes
        if full_path.startswith("api/"):
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="API not found")
        return FileResponse(frontend_dist / "index.html")
