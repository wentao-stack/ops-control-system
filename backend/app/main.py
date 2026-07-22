from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .auth import ACCESS_TOKEN_EXPIRE_MINUTES, create_access_token, get_current_user, get_session, verify_password
from .database import Base, SessionLocal, engine
from .models import Alert, Asset, AssetService, Change, Runbook, User
from .schemas import AlertListResponse, AlertResponse, AssetDetailResponse, AssetListResponse, AssetResponse, ChangeListResponse, ChangeResponse, GPUMetricsResponse, HostMetricsResponse, InventorySummaryResponse, LoginRequest, RunbookListResponse, RunbookResponse, ServiceResponse, TokenResponse, UserResponse
from .monitor import collect_host_metrics
from .seed import seed_development_data


@asynccontextmanager
async def lifespan(_: FastAPI):
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


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
