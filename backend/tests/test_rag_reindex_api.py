"""Regression coverage for the admin RAG reindex endpoint."""

from types import SimpleNamespace
from typing import cast

from app import agent_rag
from app.main import reindex_rag
from app.models import User
from sqlalchemy.orm import Session


def test_reindex_accepts_the_authenticated_admin_user_model(monkeypatch):
    monkeypatch.setattr(agent_rag, "build_full_index", lambda session: {"total_vectors": 70})
    monkeypatch.setattr(agent_rag, "get_index_stats", lambda: {"total_vectors": 70})

    result = reindex_rag(
        session=cast(Session, object()),
        current_user=cast(User, SimpleNamespace(role="admin")),
    )

    assert result == {
        "status": "ok",
        "index_stats": {"total_vectors": 70},
        "build_stats": {"total_vectors": 70},
    }
