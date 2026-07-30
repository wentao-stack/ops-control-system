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
    id: str = Field(max_length=64)
    name: str = Field(max_length=120)
    description: str = ""
    parameters: list[WorkflowParameter] = []
    steps: list[WorkflowStep] = []
    is_active: bool = True


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


class WorkflowExecutionListResponse(BaseModel):
    items: list[WorkflowExecutionResponse]
    total: int
