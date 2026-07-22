from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.orm import Session

from .auth import hash_password
from .models import Asset, User


def _now():
    return datetime.now(UTC).replace(microsecond=0)


def seed_development_data(session: Session) -> None:
    now = _now()

    # ── Admin user ──────────────────────────────────────────────────────────
    if session.query(User).first() is None:
        session.add(
            User(
                username="admin",
                hashed_password=hash_password("admin123"),
                display_name="Administrator",
                role="admin",
                is_active=True,
                created_at=now,
            )
        )
        session.commit()

    # ── Real production servers only (idempotent) ───────────────────────────
    real_servers = [
        ("vps-sanbunto", "163.44.124.142", 22, "root", "archlinux", "Arch Linux VPS (OpenStack) — FRP+Nginx gateway"),
        ("vps-218", "149.28.44.218", 22, "root", "vultr", "Alpine Linux VPS — Hermes Agent host (Caddy+FRP+Docker)"),
        ("host-b", "163.44.124.142", 2222, "wentao", "wentao-MS-7C91", "Ubuntu workstation — RTX 3090 AI dev machine"),
    ]
    for slug, ip, port, user, hostname, summary in real_servers:
        asset_id = f"asset-prod-{slug}"
        existing = session.query(Asset).filter(Asset.id == asset_id).first()
        if existing is None:
            session.add(Asset(
                id=asset_id,
                name=f"{hostname} ({ip})",
                asset_type="host",
                environment="production",
                owner="Platform",
                criticality="high",
                health_status="healthy",
                health_summary=summary,
                ssh_host=ip,
                ssh_port=port,
                ssh_user=user,
                last_seen_at=now,
                created_at=now,
                updated_at=now,
            ))
        else:
            for field, value in [("ssh_host", ip), ("ssh_port", port), ("ssh_user", user)]:
                setattr(existing, field, value)
            existing.updated_at = now
        session.commit()
