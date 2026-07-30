from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


# ── Template schemas ─────────────────────────────────────────────────────

class WorkflowParameter(BaseModel):
    name: str
    type: str = "str"  # str | int | float | bool | list
    description: str = ""
    required: bool = False
    default: object = None


class WorkflowStep(BaseModel):
    type: str  # llm | api | note_create | script
    name: str
    config: dict = {}


class WorkflowTemplateCreate(BaseModel):
    id: str | None = None
    name: str = Field(max_length=120)
    description: str = ""
    parameters: list[WorkflowParameter] = []
    steps: list[WorkflowStep] = []
    is_active: bool = True


class WorkflowTemplateUpdate(BaseModel):
    """Partial update for a workflow template."""
    name: str | None = None
    description: str | None = None
    parameters: list[WorkflowParameter] | None = None
    steps: list[WorkflowStep] | None = None
    is_active: bool | None = None


class WorkflowTemplateResponse(BaseModel):
    id: str
    name: str
    description: str
    parameters: list[WorkflowParameter] = []
    steps: list[WorkflowStep] = []
    is_active: bool
    created_at: datetime
    updated_at: datetime


class WorkflowTemplateListResponse(BaseModel):
    items: list[WorkflowTemplateResponse]
    total: int


# ── Execution schemas ────────────────────────────────────────────────────

class WorkflowRunRequest(BaseModel):
    template_id: str
    parameters: dict = {}


class ExecutionStepResult(BaseModel):
    """A single step's result within an execution."""
    step: str
    status: str  # completed | failed
    result: dict = {}
    error: str | None = None
    started_at: str | None = None
    completed_at: str | None = None


class WorkflowExecutionResponse(BaseModel):
    id: int
    template_id: str
    parameters: dict = {}
    status: str
    result: list[dict] = []
    error: str | None = None
    user: str
    started_at: datetime
    completed_at: datetime | None = None


class WorkflowExecutionDetailResponse(BaseModel):
    """Extended execution response with step-by-step details."""
    id: int
    template_id: str
    template_name: str = ""
    parameters: dict = {}
    status: str
    steps: list[ExecutionStepResult] = []
    error: str | None = None
    user: str
    started_at: datetime
    completed_at: datetime | None = None
    duration_seconds: float = 0.0


class WorkflowExecutionListResponse(BaseModel):
    items: list[WorkflowExecutionResponse]
    total: int
