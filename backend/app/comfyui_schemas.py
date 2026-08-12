from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ComfyParamDef(BaseModel):
    """單一可控參數的定義（由模板 meta 提供）。"""

    key: str
    label: str
    type: str  # textarea | text | number | slider | select | seed | image
    required: bool = False
    default: Any = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None
    help: str | None = None
    placeholder: str | None = None
    unit: str | None = None  # 顯示單位（如 秒），滑桿數值旁顯示
    advanced: bool = False
    node_id: str | None = None
    node_title: str | None = None


class ComfyWorkflowTemplate(BaseModel):
    """對前端暴露的工作流模板（不含內部 node 映射）。"""

    id: str
    name: str
    description: str | None = None
    category: str = "general"
    icon: str = "🎨"
    model: str | None = None
    estimated_time: str | None = None
    output_kind: str = "image"  # image | video | audio
    params: list[ComfyParamDef] = Field(default_factory=list)
    filename: str | None = None
    workflow_format: str = "ui"
    node_count: int = 0
    updated_at: int | None = None
    runnable: bool = True
    disabled_reason: str | None = None


class ComfyWorkflowListResponse(BaseModel):
    templates: list[ComfyWorkflowTemplate]


class ComfyWorkflowRenameRequest(BaseModel):
    """工作流的新檔名；保留其原本所在的子資料夾。"""

    name: str = Field(min_length=1, max_length=180)


class ComfyStatusDevice(BaseModel):
    name: str | None = None
    vram_total: float | None = None
    vram_free: float | None = None


class ComfyStatusResponse(BaseModel):
    online: bool = False
    comfyui_version: str | None = None
    devices: list[ComfyStatusDevice] = Field(default_factory=list)
    queue_running: int = 0
    queue_pending: int = 0
    error: str | None = None


class ComfyGenerateRequest(BaseModel):
    workflow_id: str
    params: dict[str, Any] = Field(default_factory=dict)


class ComfyGenerateResponse(BaseModel):
    job_id: str
    prompt_id: str
    status: str


class ComfyOutputItem(BaseModel):
    filename: str
    subfolder: str = ""
    type: str = "output"
    kind: str = "image"  # image | gif | video | audio
    node_id: str | None = None


class ComfyArtifact(ComfyOutputItem):
    """output 目錄中發現的作品（包括由 ComfyUI 控制台生成者）。"""

    id: str
    modified_at: float
    size_bytes: int = 0


class ComfyArtifactListResponse(BaseModel):
    artifacts: list[ComfyArtifact] = Field(default_factory=list)
    total: int = 0
    offset: int = 0
    limit: int = 24


class ComfyJobResponse(BaseModel):
    id: str
    prompt_id: str | None = None
    workflow_id: str
    workflow_name: str
    current_node: str | None = None
    current_node_title: str | None = None
    step_value: float | None = None
    step_max: float | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    status: str
    progress: int = 0
    error: str | None = None
    outputs: list[ComfyOutputItem] = Field(default_factory=list)
    created_by: str | None = None
    created_at: datetime | None = None
    finished_at: datetime | None = None


class ComfyJobListResponse(BaseModel):
    jobs: list[ComfyJobResponse]


class ComfyUploadResponse(BaseModel):
    filename: str
    subfolder: str = ""
    type: str = "input"
