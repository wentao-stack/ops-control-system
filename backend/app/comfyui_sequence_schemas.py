from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from .comfyui_schemas import ComfyOutputItem


class ComfySequenceCreate(BaseModel):
    title: str = Field(default="未命名長動畫", min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=5000)
    first_frame: str = Field(min_length=1, max_length=500)
    character_ref: str = Field(min_length=1, max_length=500)
    background_ref: str = Field(min_length=1, max_length=500)
    width: int = Field(default=864, ge=256, le=1920)
    height: int = Field(default=480, ge=256, le=1080)
    segment_seconds: int = Field(default=10, ge=5, le=15)
    total_seconds: int = Field(default=30, ge=5, le=300)
    seed: int = -1

    @model_validator(mode="after")
    def validate_dimensions(self):
        if self.width % 16 or self.height % 16:
            raise ValueError("寬度與高度必須是 16 的倍數")
        return self


class ComfySequenceSegment(BaseModel):
    index: int
    prompt_id: str
    requested_seconds: int
    frames: int
    output: ComfyOutputItem
    last_frame: str


class ComfySequenceResponse(BaseModel):
    id: str
    title: str
    prompt: str
    first_frame: str
    character_ref: str
    background_ref: str
    width: int
    height: int
    segment_seconds: int
    total_seconds: int
    seed: int
    status: str
    progress: int
    current_segment: int
    total_segments: int
    current_prompt_id: str | None = None
    segments: list[ComfySequenceSegment] = Field(default_factory=list)
    final_output: ComfyOutputItem | None = None
    error: str | None = None
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None = None


class ComfySequenceListResponse(BaseModel):
    sequences: list[ComfySequenceResponse]
