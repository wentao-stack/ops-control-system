from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


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
