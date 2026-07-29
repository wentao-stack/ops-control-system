"""SQLite database backup utility — VACUUM INTO + retention."""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from .database import engine

BACKUP_DIR = Path(__file__).resolve().parents[2] / "storage" / "backups"
RETENTION_DAYS = 7


def backup_database() -> Path:
    """Create an online SQLite backup via VACUUM INTO."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now().strftime("%Y%m%d")
    backup_file = BACKUP_DIR / f"ops_{now}.db"

    from sqlalchemy import text

    with engine.connect() as conn:
        conn.execute(text(f"VACUUM INTO '{backup_file}'"))
        conn.commit()

    # Set restrictive permissions
    os.chmod(backup_file, 0o600)

    _cleanup_old_backups()
    return backup_file


def _cleanup_old_backups() -> None:
    """Remove backups older than RETENTION_DAYS."""
    for f in sorted(BACKUP_DIR.glob("ops_*.db")):
        age = (datetime.now() - datetime.fromtimestamp(f.stat().st_mtime)).days
        if age > RETENTION_DAYS:
            f.unlink()


if __name__ == "__main__":
    path = backup_database()
    print(f"Backup created: {path} ({path.stat().st_size} bytes)")
