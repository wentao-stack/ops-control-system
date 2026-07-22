from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


# ── Auth schemas ──────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserResponse(BaseModel):
    id: int
    username: str
    display_name: str
    role: str
    is_active: bool

    class Config:
        from_attributes = True


# ── Inventory schemas ────────────────────────────────────────────────────────

class ServiceResponse(BaseModel):
    id: str
    name: str
    service_type: str
    status: str
    status_summary: str | None
    observed_at: datetime | None


class AssetResponse(BaseModel):
    id: str
    name: str
    asset_type: str
    environment: str
    owner: str
    criticality: str
    health_status: str
    health_summary: str | None
    last_seen_at: datetime | None


class AssetDetailResponse(AssetResponse):
    services: list[ServiceResponse]


class AssetListResponse(BaseModel):
    items: list[AssetResponse]
    total: int
    page: int
    page_size: int
    generated_at: datetime


class InventorySummaryResponse(BaseModel):
    total: int
    by_health: dict[str, int]
    by_environment: dict[str, int]
    generated_at: datetime


# ── Host monitoring schemas ──────────────────────────────────────────────────

class GPUMetricsResponse(BaseModel):
    name: str
    temperature_c: int
    utilization_gpu: int
    memory_used_mb: int
    memory_total_mb: int
    power_draw_w: float
    fan_speed: int


class HostMetricsResponse(BaseModel):
    timestamp: str
    hostname: str
    uptime_seconds: float
    cpu_percent: float
    cpu_count: int
    cpu_freq_mhz: float
    load_avg_1: float
    load_avg_5: float
    load_avg_15: float
    mem_total_mb: int
    mem_used_mb: int
    mem_available_mb: int
    mem_percent: float
    swap_total_mb: int
    swap_used_mb: int
    swap_percent: float
    disk_total_mb: int
    disk_used_mb: int
    disk_free_mb: int
    disk_percent: float
    gpus: list[GPUMetricsResponse]


# ── Alerts schemas ───────────────────────────────────────────────────────────

class AlertResponse(BaseModel):
    id: int
    title: str
    severity: str
    source: str
    message: str
    acknowledged: bool
    acknowledged_by: str | None
    created_at: datetime
    acknowledged_at: datetime | None


class AlertListResponse(BaseModel):
    items: list[AlertResponse]
    total: int
    generated_at: datetime


# ── Changes schemas ──────────────────────────────────────────────────────────

class ChangeResponse(BaseModel):
    id: int
    title: str
    change_type: str
    status: str
    author: str
    description: str
    affected_assets: str | None
    created_at: datetime
    completed_at: datetime | None


class ChangeListResponse(BaseModel):
    items: list[ChangeResponse]
    total: int
    generated_at: datetime


# ── Runbooks schemas ─────────────────────────────────────────────────────────

class RunbookResponse(BaseModel):
    id: int
    title: str
    category: str
    description: str
    steps: str
    author: str
    created_at: datetime
    updated_at: datetime


class RunbookListResponse(BaseModel):
    items: list[RunbookResponse]
    total: int
    generated_at: datetime


# ── Remote execution schemas ─────────────────────────────────────────────────

class RemoteExecRequest(BaseModel):
    asset_id: str
    command: str
    timeout: int = 30


class RemoteExecResponse(BaseModel):
    stdout: str
    stderr: str
    exit_code: int
    duration: float


class RemotePingResponse(BaseModel):
    asset_id: str
    name: str
    reachable: bool
