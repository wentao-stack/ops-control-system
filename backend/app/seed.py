from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from .auth import hash_password
from .models import Alert, Asset, AssetService, Change, Runbook, User


def seed_development_data(session: Session) -> None:
    # Seed admin user if not exists
    if session.query(User).first() is None:
        session.add(
            User(
                username="admin",
                hashed_password=hash_password("admin123"),
                display_name="Administrator",
                role="admin",
                is_active=True,
                created_at=datetime.now(UTC),
            )
        )
        session.commit()

    if session.query(Asset).first() is not None:
        # Check if new tables need seeding
        if not session.query(Alert).first():
            now = datetime.now(UTC).replace(microsecond=0)
            session.add_all([
                Alert(id=1, title="staging-data-01 storage threshold breach", severity="critical", source="staging-data-01", message="Inventory store has exceeded 90% storage capacity. Immediate action required to prevent service disruption.", acknowledged=False, acknowledged_by=None, created_at=now - timedelta(minutes=8), acknowledged_at=None),
                Alert(id=2, title="dev-worker-01 queue latency elevated", severity="warning", source="dev-worker-01", message="Background event processing queue latency has exceeded the development target of 500ms for the past 15 minutes.", acknowledged=True, acknowledged_by="admin", created_at=now - timedelta(minutes=25), acknowledged_at=now - timedelta(minutes=20)),
                Alert(id=3, title="prod-observer-01 heartbeat missed", severity="warning", source="prod-observer-01", message="No heartbeat received from prod-observer-01 in the last 30 minutes. Container may be stalled or unresponsive.", acknowledged=False, acknowledged_by=None, created_at=now - timedelta(minutes=32), acknowledged_at=None),
                Alert(id=4, title="SSL certificate expiring in 14 days", severity="info", source="ops.sanbunto.online", message="The TLS certificate for ops.sanbunto.online expires on 2026-08-05. Renew before expiration to avoid service interruption.", acknowledged=True, acknowledged_by="admin", created_at=now - timedelta(hours=2), acknowledged_at=now - timedelta(hours=1)),
                Alert(id=5, title="Disk usage above 80% on /dev/sda1", severity="warning", source="wentao-MS-7C91", message="Root filesystem usage has reached 82%. Consider cleaning up old build artifacts and logs.", acknowledged=False, acknowledged_by=None, created_at=now - timedelta(hours=3), acknowledged_at=None),
            ])
            session.add_all([
                Change(id=1, title="Deploy inventory dashboard v0", change_type="deploy", status="completed", author="Platform", description="Initial deployment of the SQLite-based inventory dashboard with FastAPI backend and React frontend.", affected_assets="prod-edge-01, prod-observer-01", created_at=now - timedelta(days=2), completed_at=now - timedelta(days=1)),
                Change(id=2, title="Add host monitoring to ops dashboard", change_type="infra", status="in_progress", author="Platform", description="Integrate real-time host metrics (CPU, memory, GPU, disk) into the ops control dashboard.", affected_assets="wentao-MS-7C91", created_at=now - timedelta(hours=4), completed_at=None),
                Change(id=3, title="Renew SSL certificate for ops.sanbunto.online", change_type="maintenance", status="planned", author="Security", description="Rotate TLS certificate before expiration on 2026-08-05. Includes FRP proxy config update.", affected_assets="ops.sanbunto.online", created_at=now - timedelta(hours=2), completed_at=None),
                Change(id=4, title="Investigate staging-data-01 storage breach", change_type="incident", status="in_progress", author="Data Platform", description="Storage threshold breach detected on staging database. Investigating root cause and expanding capacity.", affected_assets="staging-data-01", created_at=now - timedelta(minutes=10), completed_at=None),
                Change(id=5, title="Update Nginx configuration for new upstream", change_type="config", status="completed", author="Platform", description="Added upstream block for ops-control-system on port 18080 in /etc/nginx/nginx.conf.", affected_assets=None, created_at=now - timedelta(days=3), completed_at=now - timedelta(days=3, hours=23)),
            ])
            session.add_all([
                Runbook(id=1, title="Restart a stalled container", category="Operations", description="Standard procedure for restarting a container that has stopped responding to health checks.", steps="1. SSH to the host: ssh root@<host>\n2. Check container status: docker ps -a | grep <container>\n3. Attempt graceful restart: docker restart <container>\n4. Verify logs: docker logs --tail 50 <container>\n5. If still failing, inspect disk space: df -h\n6. Escalate to Platform team if restart does not resolve", author="Platform", created_at=now - timedelta(days=5), updated_at=now - timedelta(days=1)),
                Runbook(id=2, title="Rotate TLS certificate", category="Security", description="Procedure for renewing and deploying a new TLS certificate for ops.sanbunto.online.", steps="1. Generate new cert: certbot certonly --standalone -d ops.sanbunto.online\n2. Backup existing: cp /etc/letsencrypt/live/ops.sanbunto.online/fullchain.pem{,.bak}\n3. Reload Nginx: systemctl reload nginx\n4. Verify: curl -vI https://ops.sanbunto.online\n5. Update FRP config if needed\n6. Document in change log", author="Security", created_at=now - timedelta(days=10), updated_at=now - timedelta(days=2)),
                Runbook(id=3, title="Clear disk space on root filesystem", category="Maintenance", description="Steps to safely reclaim disk space when root filesystem usage exceeds 80%.", steps="1. Identify large directories: du -sh /* | sort -rh | head -20\n2. Clean old logs: find /var/log -name '*.gz' -mtime +30 -delete\n3. Remove old Docker images: docker system prune -a --filter 'until=720h'\n4. Clear pip cache: rm -rf ~/.cache/pip\n5. Remove stale build artifacts: find /tmp -mtime +7 -exec rm -rf {} +\n6. Verify: df -h /", author="Platform", created_at=now - timedelta(days=7), updated_at=now - timedelta(days=3)),
                Runbook(id=4, title="Investigate GPU memory leak", category="Troubleshooting", description="Diagnostic steps for identifying and resolving GPU memory leaks on the RTX 3090.", steps="1. Check current usage: nvidia-smi\n2. List GPU processes: fuser -v /dev/nvidia*\n3. Identify leaking process: watch -n 5 'nvidia-smi --query-gpu=pid,memory.used --format=csv'\n4. Kill orphaned processes: kill -9 <pid>\n5. If ComfyUI related, restart with: LANG=C comfy launch --background\n6. Monitor for recurrence over 30 minutes", author="Platform", created_at=now - timedelta(days=4), updated_at=now - timedelta(days=1)),
            ])
            session.commit()
        return

    now = datetime.now(UTC).replace(microsecond=0)

    # ── Assets ──────────────────────────────────────────────────────────────
    session.add_all([
        Asset(id="asset-dev-api-01", name="dev-api-01", asset_type="host", environment="development", owner="Platform", criticality="high", health_status="healthy", health_summary="All development API checks are within normal limits.", last_seen_at=now - timedelta(minutes=2), created_at=now, updated_at=now),
        Asset(id="asset-dev-worker-01", name="dev-worker-01", asset_type="host", environment="development", owner="Platform", criticality="medium", health_status="warning", health_summary="Background queue latency is above the development target.", last_seen_at=now - timedelta(minutes=5), created_at=now, updated_at=now),
        Asset(id="asset-staging-web-01", name="staging-web-01", asset_type="service", environment="staging", owner="Web Experience", criticality="high", health_status="healthy", health_summary="Synthetic availability check is passing.", last_seen_at=now - timedelta(minutes=1), created_at=now, updated_at=now),
        Asset(id="asset-staging-db-01", name="staging-data-01", asset_type="service", environment="staging", owner="Data Platform", criticality="high", health_status="critical", health_summary="Storage threshold test requires operator review.", last_seen_at=now - timedelta(minutes=8), created_at=now, updated_at=now),
        Asset(id="asset-prod-edge-01", name="prod-edge-01", asset_type="service", environment="production", owner="Platform", criticality="high", health_status="healthy", health_summary="Public edge health checks are passing.", last_seen_at=now - timedelta(minutes=3), created_at=now, updated_at=now),
        Asset(id="asset-prod-observer-01", name="prod-observer-01", asset_type="container", environment="production", owner="Observability", criticality="low", health_status="unknown", health_summary="No recent observation has been received from the development fixture.", last_seen_at=None, created_at=now, updated_at=now),
    ])
    session.add_all([
        AssetService(id="service-dev-api", asset_id="asset-dev-api-01", name="inventory-api", service_type="api", status="healthy", status_summary="HTTP readiness check passing.", observed_at=now - timedelta(minutes=2)),
        AssetService(id="service-dev-worker", asset_id="asset-dev-worker-01", name="event-worker", service_type="worker", status="warning", status_summary="Queue processing is delayed.", observed_at=now - timedelta(minutes=5)),
        AssetService(id="service-staging-web", asset_id="asset-staging-web-01", name="web-console", service_type="web", status="healthy", status_summary="Synthetic check passing.", observed_at=now - timedelta(minutes=1)),
        AssetService(id="service-staging-data", asset_id="asset-staging-db-01", name="inventory-store", service_type="database", status="critical", status_summary="Fixture reports a storage threshold breach.", observed_at=now - timedelta(minutes=8)),
        AssetService(id="service-prod-edge", asset_id="asset-prod-edge-01", name="edge-router", service_type="proxy", status="healthy", status_summary="Routing check passing.", observed_at=now - timedelta(minutes=3)),
    ])

    # ── Alerts ──────────────────────────────────────────────────────────────
    session.add_all([
        Alert(id=1, title="staging-data-01 storage threshold breach", severity="critical", source="staging-data-01", message="Inventory store has exceeded 90% storage capacity. Immediate action required to prevent service disruption.", acknowledged=False, acknowledged_by=None, created_at=now - timedelta(minutes=8), acknowledged_at=None),
        Alert(id=2, title="dev-worker-01 queue latency elevated", severity="warning", source="dev-worker-01", message="Background event processing queue latency has exceeded the development target of 500ms for the past 15 minutes.", acknowledged=True, acknowledged_by="admin", created_at=now - timedelta(minutes=25), acknowledged_at=now - timedelta(minutes=20)),
        Alert(id=3, title="prod-observer-01 heartbeat missed", severity="warning", source="prod-observer-01", message="No heartbeat received from prod-observer-01 in the last 30 minutes. Container may be stalled or unresponsive.", acknowledged=False, acknowledged_by=None, created_at=now - timedelta(minutes=32), acknowledged_at=None),
        Alert(id=4, title="SSL certificate expiring in 14 days", severity="info", source="ops.sanbunto.online", message="The TLS certificate for ops.sanbunto.online expires on 2026-08-05. Renew before expiration to avoid service interruption.", acknowledged=True, acknowledged_by="admin", created_at=now - timedelta(hours=2), acknowledged_at=now - timedelta(hours=1)),
        Alert(id=5, title="Disk usage above 80% on /dev/sda1", severity="warning", source="wentao-MS-7C91", message="Root filesystem usage has reached 82%. Consider cleaning up old build artifacts and logs.", acknowledged=False, acknowledged_by=None, created_at=now - timedelta(hours=3), acknowledged_at=None),
    ])

    # ── Changes ─────────────────────────────────────────────────────────────
    session.add_all([
        Change(id=1, title="Deploy inventory dashboard v0", change_type="deploy", status="completed", author="Platform", description="Initial deployment of the SQLite-based inventory dashboard with FastAPI backend and React frontend.", affected_assets="prod-edge-01, prod-observer-01", created_at=now - timedelta(days=2), completed_at=now - timedelta(days=1)),
        Change(id=2, title="Add host monitoring to ops dashboard", change_type="infra", status="in_progress", author="Platform", description="Integrate real-time host metrics (CPU, memory, GPU, disk) into the ops control dashboard.", affected_assets="wentao-MS-7C91", created_at=now - timedelta(hours=4), completed_at=None),
        Change(id=3, title="Renew SSL certificate for ops.sanbunto.online", change_type="maintenance", status="planned", author="Security", description="Rotate TLS certificate before expiration on 2026-08-05. Includes FRP proxy config update.", affected_assets="ops.sanbunto.online", created_at=now - timedelta(hours=2), completed_at=None),
        Change(id=4, title="Investigate staging-data-01 storage breach", change_type="incident", status="in_progress", author="Data Platform", description="Storage threshold breach detected on staging database. Investigating root cause and expanding capacity.", affected_assets="staging-data-01", created_at=now - timedelta(minutes=10), completed_at=None),
        Change(id=5, title="Update Nginx configuration for new upstream", change_type="config", status="completed", author="Platform", description="Added upstream block for ops-control-system on port 18080 in /etc/nginx/nginx.conf.", affected_assets=None, created_at=now - timedelta(days=3), completed_at=now - timedelta(days=3, hours=23)),
    ])

    # ── Runbooks ────────────────────────────────────────────────────────────
    session.add_all([
        Runbook(id=1, title="Restart a stalled container", category="Operations", description="Standard procedure for restarting a container that has stopped responding to health checks.", steps="1. SSH to the host: ssh root@<host>\n2. Check container status: docker ps -a | grep <container>\n3. Attempt graceful restart: docker restart <container>\n4. Verify logs: docker logs --tail 50 <container>\n5. If still failing, inspect disk space: df -h\n6. Escalate to Platform team if restart does not resolve", author="Platform", created_at=now - timedelta(days=5), updated_at=now - timedelta(days=1)),
        Runbook(id=2, title="Rotate TLS certificate", category="Security", description="Procedure for renewing and deploying a new TLS certificate for ops.sanbunto.online.", steps="1. Generate new cert: certbot certonly --standalone -d ops.sanbunto.online\n2. Backup existing: cp /etc/letsencrypt/live/ops.sanbunto.online/fullchain.pem{,.bak}\n3. Reload Nginx: systemctl reload nginx\n4. Verify: curl -vI https://ops.sanbunto.online\n5. Update FRP config if needed\n6. Document in change log", author="Security", created_at=now - timedelta(days=10), updated_at=now - timedelta(days=2)),
        Runbook(id=3, title="Clear disk space on root filesystem", category="Maintenance", description="Steps to safely reclaim disk space when root filesystem usage exceeds 80%.", steps="1. Identify large directories: du -sh /* | sort -rh | head -20\n2. Clean old logs: find /var/log -name '*.gz' -mtime +30 -delete\n3. Remove old Docker images: docker system prune -a --filter 'until=720h'\n4. Clear pip cache: rm -rf ~/.cache/pip\n5. Remove stale build artifacts: find /tmp -mtime +7 -exec rm -rf {} +\n6. Verify: df -h /", author="Platform", created_at=now - timedelta(days=7), updated_at=now - timedelta(days=3)),
        Runbook(id=4, title="Investigate GPU memory leak", category="Troubleshooting", description="Diagnostic steps for identifying and resolving GPU memory leaks on the RTX 3090.", steps="1. Check current usage: nvidia-smi\n2. List GPU processes: fuser -v /dev/nvidia*\n3. Identify leaking process: watch -n 5 'nvidia-smi --query-gpu=pid,memory.used --format=csv'\n4. Kill orphaned processes: kill -9 <pid>\n5. If ComfyUI related, restart with: LANG=C comfy launch --background\n6. Monitor for recurrence over 30 minutes", author="Platform", created_at=now - timedelta(days=4), updated_at=now - timedelta(days=1)),
    ])

    session.commit()
