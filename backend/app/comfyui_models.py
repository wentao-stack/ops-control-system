from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class ComfyJob(Base):
    __tablename__ = "comfy_jobs"
    __table_args__ = (
        Index("idx_comfy_jobs_created", "created_at"),
        Index("idx_comfy_jobs_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    prompt_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    workflow_id: Mapped[str] = mapped_column(String(64), nullable=False)
    workflow_name: Mapped[str] = mapped_column(String(128), nullable=False)
    params_json: Mapped[str] = mapped_column(Text, nullable=False, server_default="{}")
    status: Mapped[str] = mapped_column(String(24), nullable=False, server_default="queued")
    progress: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    outputs_json: Mapped[str] = mapped_column(Text, nullable=False, server_default="[]")
    created_by: Mapped[str] = mapped_column(String(64), nullable=False, server_default="admin")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ComfyArtifactRecord(Base):
    """Persistent index of files found in ComfyUI output."""

    __tablename__ = "comfy_artifacts"
    __table_args__ = (
        Index("idx_comfy_artifacts_modified", "modified_at"),
        Index("idx_comfy_artifacts_path", "subfolder", "filename", unique=True),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    subfolder: Mapped[str] = mapped_column(String(1024), nullable=False, server_default="")
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    file_type: Mapped[str] = mapped_column(String(24), nullable=False, server_default="output")
    modified_at: Mapped[float] = mapped_column(Float, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
