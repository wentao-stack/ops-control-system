from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


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
