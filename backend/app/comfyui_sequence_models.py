from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class ComfySequence(Base):
    """A long-video job composed from several chained ComfyUI clips."""

    __tablename__ = "comfy_sequences"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    prompt: Mapped[str] = mapped_column(Text)
    first_frame: Mapped[str] = mapped_column(String(500))
    character_ref: Mapped[str] = mapped_column(String(500))
    background_ref: Mapped[str] = mapped_column(String(500))
    width: Mapped[int] = mapped_column(Integer, default=864)
    height: Mapped[int] = mapped_column(Integer, default=480)
    segment_seconds: Mapped[int] = mapped_column(Integer, default=10)
    total_seconds: Mapped[int] = mapped_column(Integer, default=30)
    seed: Mapped[int] = mapped_column(Integer, default=-1)
    status: Mapped[str] = mapped_column(String(30), default="queued", index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    current_segment: Mapped[int] = mapped_column(Integer, default=0)
    total_segments: Mapped[int] = mapped_column(Integer, default=1)
    current_prompt_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    segments_json: Mapped[str] = mapped_column(Text, default="[]")
    final_output_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
