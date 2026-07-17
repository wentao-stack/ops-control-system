from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from .models import Asset, AssetService


def seed_development_data(session: Session) -> None:
    if session.query(Asset).first() is not None:
        return

    now = datetime.now(UTC).replace(microsecond=0)
    assets = [
        Asset(id="asset-dev-api-01", name="dev-api-01", asset_type="host", environment="development", owner="Platform", criticality="high", health_status="healthy", health_summary="All development API checks are within normal limits.", last_seen_at=now - timedelta(minutes=2), created_at=now, updated_at=now),
        Asset(id="asset-dev-worker-01", name="dev-worker-01", asset_type="host", environment="development", owner="Platform", criticality="medium", health_status="warning", health_summary="Background queue latency is above the development target.", last_seen_at=now - timedelta(minutes=5), created_at=now, updated_at=now),
        Asset(id="asset-staging-web-01", name="staging-web-01", asset_type="service", environment="staging", owner="Web Experience", criticality="high", health_status="healthy", health_summary="Synthetic availability check is passing.", last_seen_at=now - timedelta(minutes=1), created_at=now, updated_at=now),
        Asset(id="asset-staging-db-01", name="staging-data-01", asset_type="service", environment="staging", owner="Data Platform", criticality="high", health_status="critical", health_summary="Storage threshold test requires operator review.", last_seen_at=now - timedelta(minutes=8), created_at=now, updated_at=now),
        Asset(id="asset-prod-edge-01", name="prod-edge-01", asset_type="service", environment="production", owner="Platform", criticality="high", health_status="healthy", health_summary="Public edge health checks are passing.", last_seen_at=now - timedelta(minutes=3), created_at=now, updated_at=now),
        Asset(id="asset-prod-observer-01", name="prod-observer-01", asset_type="container", environment="production", owner="Observability", criticality="low", health_status="unknown", health_summary="No recent observation has been received from the development fixture.", last_seen_at=None, created_at=now, updated_at=now),
    ]
    session.add_all(assets)
    session.add_all([
        AssetService(id="service-dev-api", asset_id="asset-dev-api-01", name="inventory-api", service_type="api", status="healthy", status_summary="HTTP readiness check passing.", observed_at=now - timedelta(minutes=2)),
        AssetService(id="service-dev-worker", asset_id="asset-dev-worker-01", name="event-worker", service_type="worker", status="warning", status_summary="Queue processing is delayed.", observed_at=now - timedelta(minutes=5)),
        AssetService(id="service-staging-web", asset_id="asset-staging-web-01", name="web-console", service_type="web", status="healthy", status_summary="Synthetic check passing.", observed_at=now - timedelta(minutes=1)),
        AssetService(id="service-staging-data", asset_id="asset-staging-db-01", name="inventory-store", service_type="database", status="critical", status_summary="Fixture reports a storage threshold breach.", observed_at=now - timedelta(minutes=8)),
        AssetService(id="service-prod-edge", asset_id="asset-prod-edge-01", name="edge-router", service_type="proxy", status="healthy", status_summary="Routing check passing.", observed_at=now - timedelta(minutes=3)),
    ])
    session.commit()
