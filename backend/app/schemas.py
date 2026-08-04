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
    health_summary: str | None = None
    last_seen_at: datetime | None = None
    ssh_host: str | None = None
    ssh_port: int | None = None
    ssh_user: str | None = None
    local_machine: bool = False

    class Config:
        from_attributes = True


class AssetDetailResponse(AssetResponse):
    services: list[ServiceResponse] = []


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


# ── Remote host monitoring schemas ───────────────────────────────────────────

class RemoteGPUMetricsResponse(BaseModel):
    name: str
    temperature_c: int
    utilization_gpu: int
    memory_used_mb: int
    memory_total_mb: int
    power_draw_w: float
    fan_speed: int


class RemoteHostMetricsResponse(BaseModel):
    asset_id: str
    name: str
    hostname: str
    reachable: bool
    error: str
    cpu_percent: float
    cpu_count: int
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
    gpus: list[RemoteGPUMetricsResponse]


class RemoteHostsMetricsResponse(BaseModel):
    hosts: list[RemoteHostMetricsResponse]
    collected_at: str


# ── Remote service detection schemas ─────────────────────────────────────────

class RemoteServiceResponse(BaseModel):
    name: str
    service_type: str
    status: str
    pid: str = ""
    ports: str = ""
    description: str = ""
    uptime: str = ""


class RemoteHostServicesResponse(BaseModel):
    asset_id: str
    name: str
    hostname: str
    reachable: bool
    services: list[RemoteServiceResponse]


class RemoteAllServicesResponse(BaseModel):
    hosts: list[RemoteHostServicesResponse]
    collected_at: str


# ── Supervisor process management schemas ────────────────────────────────────

class SupervisorProcessResponse(BaseModel):
    name: str
    group: str
    display_name: str
    status: str
    pid: int
    uptime: str = ""


class SupervisorHostStatusResponse(BaseModel):
    asset_id: str
    name: str
    hostname: str
    reachable: bool
    error: str = ""
    processes: list[SupervisorProcessResponse]


class SupervisorAllStatusResponse(BaseModel):
    hosts: list[SupervisorHostStatusResponse]
    collected_at: str


class SupervisorActionRequest(BaseModel):
    asset_id: str
    action: str  # start | stop | restart | signal
    process: str  # process name or "all"
    signal: str = ""  # for action=signal only


class SupervisorActionResponse(BaseModel):
    success: bool
    process: str
    message: str
    stdout: str = ""
    stderr: str = ""


class SupervisorTailRequest(BaseModel):
    asset_id: str
    process: str
    log_type: str = "stdout"  # stdout | stderr
    lines: int = 100


class SupervisorTailResponse(BaseModel):
    process: str
    lines: list[str]
    truncated: bool = False
    sources: list["SupervisorLogSourceResponse"] = []


class SupervisorLogSourceResponse(BaseModel):
    source: str  # "supervisor" or "app"
    label: str
    path: str
    lines: list[str]


# ── Notes schemas ────────────────────────────────────────────────────────────

class NoteCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    category: str = Field(min_length=1, max_length=24)
    content: str = ""
    tags: list[str] = []
    pinned: bool = False
    published: bool = True


class NoteUpdate(BaseModel):
    title: str | None = None
    category: str | None = None
    content: str | None = None
    tags: list[str] | None = None
    pinned: bool | None = None
    published: bool | None = None


class NoteResponse(BaseModel):
    id: str
    title: str
    category: str
    content: str
    tags: list[str]
    author: str
    pinned: bool
    published: bool
    version: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class NoteListResponse(BaseModel):
    items: list[NoteResponse]
    total: int
    page: int
    page_size: int
    generated_at: datetime


# ── ExecLog schemas ──────────────────────────────────────────────────────────

class ExecLogResponse(BaseModel):
    id: int
    asset_id: str
    command: str
    stdout: str
    stderr: str
    exit_code: int
    duration: float
    user: str
    created_at: datetime

    class Config:
        from_attributes = True


class ExecLogListResponse(BaseModel):
    items: list[ExecLogResponse]
    total: int
    page: int
    page_size: int
    generated_at: datetime


# ── Code browser schemas ─────────────────────────────────────────────────────
# 程式碼瀏覽器 API 的回應結構，用於前端展示專案檔案樹和檔案內容

class CodeTreeItem(BaseModel):
    """檔案樹中的一個節點（檔案或資料夾）。資料夾節點會包含 children 子節點列表，形成遞迴樹狀結構。"""
    name: str  # 檔案或資料夾名稱
    path: str  # 相對於專案根目錄的路徑
    type: str  # "file"（檔案）或 "dir"（資料夾）
    size: int = 0  # 檔案大小（位元組），僅檔案有值，資料夾為 0
    children: list["CodeTreeItem"] = []  # 僅資料夾有子節點，檔案為空列表


class CodeTreeResponse(BaseModel):
    """檔案樹 API 的完整回應，包含樹狀結構和統計資訊。"""
    tree: list[CodeTreeItem]  # 根層級的檔案樹節點列表
    total_files: int  # 整個專案的檔案總數（不含資料夾）
    total_dirs: int  # 整個專案的資料夾總數


class CodeFileResponse(BaseModel):
    """單一檔案內容 API 的回應，包含檔案內容、語言偵測和行數。"""
    path: str  # 相對於專案根目錄的路徑
    content: str  # 檔案完整文字內容
    language: str  # 根據副檔名偵測的程式語言（用於語法著色）
    line_count: int  # 檔案總行數
