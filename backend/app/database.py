from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker


DATA_DIRECTORY = Path(__file__).resolve().parents[1] / ".data"
DATABASE_URL = f"sqlite:///{DATA_DIRECTORY / 'ops.db'}"


class Base(DeclarativeBase):
    pass


def _apply_sqlite_pragmas(dbapi_connection, _connection_record: object) -> None:
    """SQLite performance & safety pragmas."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA cache_size=-64000")  # 64 MB
    cursor.execute("PRAGMA temp_store=MEMORY")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def create_session_factory(database_url: str = DATABASE_URL):
    DATA_DIRECTORY.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        database_url,
        connect_args={"check_same_thread": False},
        pool_pre_ping=True,
    )
    event.listen(engine, "connect", _apply_sqlite_pragmas)
    return engine, sessionmaker(autocommit=False, autoflush=False, bind=engine)


engine, SessionLocal = create_session_factory()


def ensure_runbook_rag_columns() -> None:
    """Add RAG metadata columns for existing SQLite installations (idempotent)."""
    columns = {
        "tags": "TEXT NOT NULL DEFAULT '[]'", "affected_assets": "TEXT NOT NULL DEFAULT '[]'",
        "symptoms": "TEXT NOT NULL DEFAULT ''", "verification_steps": "TEXT NOT NULL DEFAULT ''",
        "rollback_steps": "TEXT NOT NULL DEFAULT ''", "status": "TEXT NOT NULL DEFAULT 'active'",
        "version": "INTEGER NOT NULL DEFAULT 1",
    }
    with engine.begin() as conn:
        names = {row[1] for row in conn.execute(text("PRAGMA table_info(runbooks)"))}
        for name, definition in columns.items():
            if name not in names:
                conn.execute(text(f"ALTER TABLE runbooks ADD COLUMN {name} {definition}"))
