from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy import Index

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(256), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, server_default="admin")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    asset_type: Mapped[str] = mapped_column(String(24), index=True)
    environment: Mapped[str] = mapped_column(String(24), index=True)
    owner: Mapped[str] = mapped_column(String(120))
    criticality: Mapped[str] = mapped_column(String(24))
    health_status: Mapped[str] = mapped_column(String(24), index=True)
    health_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # SSH remote access
    ssh_host: Mapped[str | None] = mapped_column(String(256), nullable=True)
    ssh_port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ssh_user: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # True when this asset IS the backend host itself — use local subprocess instead of SSH
    local_machine: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    services: Mapped[list["AssetService"]] = relationship(
        back_populates="asset", cascade="all, delete-orphan"
    )


class AssetService(Base):
    __tablename__ = "asset_services"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    service_type: Mapped[str] = mapped_column(String(48))
    status: Mapped[str] = mapped_column(String(24))
    status_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    asset: Mapped[Asset] = relationship(back_populates="services")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    severity: Mapped[str] = mapped_column(Enum("critical", "warning", "info", name="alert_severity"), nullable=False)
    source: Mapped[str] = mapped_column(String(120), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    acknowledged: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0")
    acknowledged_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Change(Base):
    __tablename__ = "changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    change_type: Mapped[str] = mapped_column(Enum("deploy", "config", "incident", "maintenance", "infra", name="change_type"), nullable=False)
    status: Mapped[str] = mapped_column(Enum("planned", "in_progress", "completed", "rolled_back", name="change_status"), nullable=False)
    author: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    affected_assets: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Runbook(Base):
    __tablename__ = "runbooks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    steps: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    category: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    tags: Mapped[str] = mapped_column(String(500), nullable=False, server_default="[]")
    author: Mapped[str] = mapped_column(String(64), nullable=False, server_default="admin", index=True)
    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0")
    published: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="1")
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("idx_notes_pinned_updated", "pinned", "updated_at"),
    )


class ExecLog(Base):
    __tablename__ = "exec_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_id: Mapped[str] = mapped_column(String(64), nullable=False)
    command: Mapped[str] = mapped_column(Text, nullable=False)
    stdout: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    stderr: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    exit_code: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    duration: Mapped[float] = mapped_column(Float, nullable=False, server_default="0")
    user: Mapped[str] = mapped_column(String(64), nullable=False, server_default="admin")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("idx_exec_log_asset_time", "asset_id", "created_at"),
        Index("idx_exec_log_user_time", "user", "created_at"),
    )
