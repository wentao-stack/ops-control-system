"""Regression coverage for incremental RAG source synchronization."""

from datetime import datetime, timezone
from types import SimpleNamespace

from app import agent_rag, rag_sync


class FakeCollection:
    def __init__(self):
        self.deleted = []
        self.upserts = []

    def delete(self, **kwargs):
        self.deleted.append(kwargs)

    def upsert(self, **kwargs):
        self.upserts.append(kwargs)

    def get(self, **kwargs):
        return {"ids": ["id-1"]}


def test_note_sync_replaces_existing_vectors_and_preserves_chunk_metadata(monkeypatch):
    coll = FakeCollection()
    monkeypatch.setattr(rag_sync, "get_collection", lambda: coll)
    monkeypatch.setattr(agent_rag, "embed_texts", lambda texts: [[0.1] for _ in texts])
    note = SimpleNamespace(
        id="note-1", title="部署筆記", category="knowledge", content="第一段\n\n第二段",
        published=True, created_at=datetime.now(timezone.utc),
    )

    assert rag_sync.sync_note(note) is True
    assert coll.deleted == [{"where": {"$and": [{"source": "note"}, {"source_id": "note-1"}]}}]
    assert coll.upserts[0]["ids"] == ["note:note-1:0"]
    assert coll.upserts[0]["metadatas"][0]["title"] == "部署筆記"


def test_unpublished_note_and_deleted_source_remove_vectors(monkeypatch):
    coll = FakeCollection()
    monkeypatch.setattr(rag_sync, "get_collection", lambda: coll)
    note = SimpleNamespace(id="note-2", published=False)

    assert rag_sync.sync_note(note) is True
    assert rag_sync.delete_source("memory", "7") is True
    assert coll.deleted == [
        {"where": {"$and": [{"source": "note"}, {"source_id": "note-2"}]}},
        {"where": {"$and": [{"source": "memory"}, {"source_id": "7"}]}},
    ]


def test_source_vector_counts_are_grouped_for_the_admin_panel(monkeypatch):
    monkeypatch.setattr(rag_sync, "get_collection", lambda: FakeCollection())

    stats = rag_sync.get_source_vector_counts()

    assert stats["source_vector_counts"] == {
        "runbooks": 1, "notes": 1, "changes": 1, "memories": 1,
    }
    assert stats["checked_at"]
