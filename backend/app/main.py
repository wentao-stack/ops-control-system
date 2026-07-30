from __future__ import annotations

import asyncio
import time as _time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .auth import ACCESS_TOKEN_EXPIRE_MINUTES, create_access_token, decode_ws_token, get_current_user, get_session, verify_password
from .database import Base, SessionLocal, engine
from .models import Alert, Asset, AssetService, Change, Note, Runbook, User, ExecLog
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
)
from .monitor import collect_host_metrics
from .seed import seed_development_data
from . import webssh
from .workflow_engine import run_workflow
from .workflow_models import WorkflowTemplate, WorkflowExecution
from .workflow_schemas import (
    WorkflowRunRequest,
    WorkflowTemplateCreate,
    WorkflowTemplateResponse,
    WorkflowTemplateListResponse,
    WorkflowExecutionResponse,
    WorkflowExecutionListResponse,
)
from .workflow_templates import TEMPLATES as BUILTIN_TEMPLATES

import json
import logging
from fastapi import WebSocket, WebSocketDisconnect

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
    with SessionLocal() as session:
        seed_development_data(session)
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
    return _to_note_response(note)


@app.delete("/api/v1/notes/{note_id}")
async def delete_note(note_id: str, session: Session = Depends(get_session)):
    note = session.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    session.delete(note)
    session.commit()
    return {"ok": True}


@app.post("/api/v1/notes/import-localstorage")
async def import_localstorage_notes(
    notes_data: list[NoteCreate],
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Import notes from browser localStorage to SQLite."""
    imported = 0
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
            imported += 1
    session.commit()
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


@app.post("/api/v1/workflows/templates", response_model=WorkflowTemplateResponse)
def create_workflow_template(
    tpl: WorkflowTemplateCreate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> WorkflowTemplateResponse:
    now = datetime.now(UTC).replace(microsecond=0)
    existing = session.query(WorkflowTemplate).filter(WorkflowTemplate.id == tpl.id).first()
    if existing:
        raise HTTPException(status_code=409, detail="Template already exists")
    session.add(WorkflowTemplate(
        id=tpl.id, name=tpl.name, description=tpl.description,
        parameters_schema=json.dumps([p.model_dump() for p in tpl.parameters], ensure_ascii=False),
        steps_json=json.dumps([s.model_dump() for s in tpl.steps], ensure_ascii=False),
        is_active=tpl.is_active,
        created_at=now, updated_at=now,
    ))
    session.commit()
    return WorkflowTemplateResponse(
        id=tpl.id, name=tpl.name, description=tpl.description,
        parameters=tpl.parameters, steps=tpl.steps,
        is_active=tpl.is_active, created_at=now, updated_at=now,
    )


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

    execution = await run_workflow(template, req.parameters, user.username, session)
    return WorkflowExecutionResponse(
        id=execution.id,
        template_id=execution.template_id,
        parameters=json.loads(execution.parameters_json),
        status=execution.status,
        result=json.loads(execution.result_json) if execution.result_json else [],
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
            result=json.loads(e.result_json) if e.result_json else [],
            error=e.error, user=e.user,
            started_at=e.started_at, completed_at=e.completed_at,
        ) for e in items],
        total=total,
    )


@app.get("/api/v1/workflows/executions/{execution_id}", response_model=WorkflowExecutionResponse)
def get_workflow_execution(
    execution_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> WorkflowExecutionResponse:
    execution = session.query(WorkflowExecution).filter(WorkflowExecution.id == execution_id).first()
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    return WorkflowExecutionResponse(
        id=execution.id, template_id=execution.template_id,
        parameters=json.loads(execution.parameters_json),
        status=execution.status,
        result=json.loads(execution.result_json) if execution.result_json else {},
        error=execution.error, user=execution.user,
        started_at=execution.started_at, completed_at=execution.completed_at,
    )


# ── SPA Fallback ──────────────────────────────────────────────────────────────


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    # Serve static assets directly
    app.mount("/assets", StaticFiles(directory=str(frontend_dist / "assets")), name="frontend-assets")

    # SPA fallback: serve index.html for any unmatched route
    from fastapi.responses import FileResponse

    @app.get("/{full_path:path}", response_class=FileResponse)
    async def spa_fallback(full_path: str):
        """Serve index.html for any unmatched route (SPA fallback)."""
        return FileResponse(frontend_dist / "index.html")
