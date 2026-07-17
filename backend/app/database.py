from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


DATA_DIRECTORY = Path(__file__).resolve().parents[1] / ".data"
DATABASE_URL = f"sqlite:///{DATA_DIRECTORY / 'ops-dev.db'}"


class Base(DeclarativeBase):
    pass


def create_session_factory(database_url: str = DATABASE_URL):
    if database_url == DATABASE_URL:
        DATA_DIRECTORY.mkdir(parents=True, exist_ok=True)
    engine = create_engine(database_url, connect_args={"check_same_thread": False})
    return engine, sessionmaker(autocommit=False, autoflush=False, bind=engine)


engine, SessionLocal = create_session_factory()
