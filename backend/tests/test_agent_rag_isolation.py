"""P0 regression coverage: RAG retrieval must never leak another user's memories."""

from types import SimpleNamespace

from app import agent_rag


class FakeCollection:
    """Minimal Chroma stand-in that records the where filter used per query."""

    def __init__(self, hits: list[dict]):
        self.hits = hits
        self.queries: list[dict] = []

    def query(self, **kwargs):
        self.queries.append(kwargs)
        n = kwargs.get("n_results", 5)
        ids, docs, metas, dists = [], [], [], []
        for hit in self.hits[:n]:
            ids.append(hit["id"])
            docs.append(hit["text"])
            metas.append(hit["metadata"])
            dists.append(hit.get("distance", 0.2))
        return {
            "ids": [ids],
            "documents": [docs],
            "metadatas": [metas],
            "distances": [dists],
        }


def _memory_hit(memory_id: str, user: str, text: str = "memory text") -> dict:
    return {
        "id": f"memory:{memory_id}:0",
        "text": text,
        "metadata": {"source": "memory", "source_id": str(memory_id), "user": user, "title": f"key-{memory_id}"},
    }


def _shared_hit(source: str, source_id: str, text: str = "shared text") -> dict:
    return {
        "id": f"{source}:{source_id}:0",
        "text": text,
        "metadata": {"source": source, "source_id": source_id, "title": f"{source}-{source_id}"},
    }


def test_memory_source_query_filters_by_authenticated_user(monkeypatch):
    coll = FakeCollection([_memory_hit(1, "alice"), _memory_hit(2, "bob")])
    monkeypatch.setattr(agent_rag, "get_collection", lambda: coll)
    monkeypatch.setattr(agent_rag, "embed_texts", lambda texts: [[0.1] for _ in texts])

    agent_rag.rag_search(query="anything", source="memories", limit=5, memory_user="alice")

    assert coll.queries[0]["where"] == {"$and": [{"source": "memory"}, {"user": "alice"}]}


def test_global_query_still_filters_other_users_memories(monkeypatch):
    """source='all' has no where filter, so post-filtering must drop foreign memories."""
    coll = FakeCollection([
        _shared_hit("runbook", "10"),
        _memory_hit(1, "alice"),
        _memory_hit(2, "bob"),
    ])
    monkeypatch.setattr(agent_rag, "get_collection", lambda: coll)
    monkeypatch.setattr(agent_rag, "embed_texts", lambda texts: [[0.1] for _ in texts])

    result = agent_rag.rag_search(query="anything", source="all", limit=10, memory_user="alice")

    sources = [(hit["source"], hit["source_id"]) for hit in result["results"]]
    assert ("runbook", "10") in sources
    assert ("memory", "1") in sources
    assert ("memory", "2") not in sources


def test_global_query_without_actor_returns_no_memories(monkeypatch):
    """Without an authenticated user, memories must not be returned at all."""
    coll = FakeCollection([
        _shared_hit("note", "5"),
        _memory_hit(1, "alice"),
    ])
    monkeypatch.setattr(agent_rag, "get_collection", lambda: coll)
    monkeypatch.setattr(agent_rag, "embed_texts", lambda texts: [[0.1] for _ in texts])

    result = agent_rag.rag_search(query="anything", source="all", limit=10, memory_user=None)

    sources = [hit["source"] for hit in result["results"]]
    assert "note" in sources
    assert "memory" not in sources


def test_memory_chunks_carry_owner_metadata():
    chunks = agent_rag.chunk_memory({
        "id": 7, "key": "preferred_language", "value": "zh-TW",
        "category": "preference", "user": "alice", "created_at": None,
    })
    assert chunks[0]["metadata"]["source"] == "memory"
    assert chunks[0]["metadata"]["user"] == "alice"
    assert chunks[0]["metadata"]["source_id"] == "7"
