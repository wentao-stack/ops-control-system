"""Shared fixtures for agent tool tests — uses an in-memory SQLite DB."""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.database import Base, _apply_sqlite_pragmas


@pytest.fixture()
def engine():
    """In-memory SQLite engine for tests."""
    e = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    event.listen(e, "connect", _apply_sqlite_pragmas)
    Base.metadata.create_all(e)
    return e


@pytest.fixture()
def session(engine):
    """DB session with auto-rollback after each test."""
    Sm = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    s = Sm()
    yield s
    s.rollback()
    s.close()
