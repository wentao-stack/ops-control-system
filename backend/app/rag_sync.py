"""Incremental, best-effort RAG synchronization for mutable knowledge sources."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from .agent_rag import (
    chunk_change,
    chunk_memory,
    chunk_note,
    get_collection,
)

logger = logging.getLogger(__name__)


def _source_where(source: str, source_id: str) -> dict[str, list[dict[str, str]]]:
    """Build Chroma's single-operator metadata filter for one source record."""
    return {"$and": [{"source": source}, {"source_id": str(source_id)}]}


def _replace_source(source: str, source_id: str, chunks: list[dict[str, Any]]) -> bool:
    """Replace every vector belonging to one mutable source record.

    Embeddings are produced before removing existing vectors so a temporary
    embedding outage cannot erase a previously searchable record.
    """
    try:
        coll = get_collection()
        if not chunks:
            coll.delete(where=_source_where(source, source_id))
            return True

        # _upsert_chunks owns embedding generation and catches errors, so build
        # vectors here to retain an all-or-nothing replacement boundary.
        from .agent_rag import embed_texts

        texts = [chunk["text"] for chunk in chunks]
        vectors = embed_texts(texts)
        ids = [f"{source}:{source_id}:{index}" for index, _ in enumerate(chunks)]
        metadata = [chunk["metadata"] for chunk in chunks]
        coll.delete(where=_source_where(source, source_id))
        coll.upsert(ids=ids, documents=texts, metadatas=metadata, embeddings=vectors)
        return True
    except Exception as exc:
        logger.warning("RAG sync failed [%s:%s]: %s", source, source_id, exc)
        return False


def delete_source(source: str, source_id: str) -> bool:
    """Delete every vector belonging to a source record."""
    return _replace_source(source, source_id, [])


def sync_note(note: Any) -> bool:
    """Synchronize a published Note, or remove an unpublished one."""
    if not note.published:
        return delete_source("note", str(note.id))
    payload = {
        "id": note.id, "title": note.title, "category": note.category,
        "content": note.content, "created_at": note.created_at,
    }
    return _replace_source("note", str(note.id), chunk_note(payload))


def sync_change(change: Any) -> bool:
    """Synchronize an auditable Change entry."""
    payload = {
        "id": change.id, "title": change.title, "change_type": change.change_type,
        "status": change.status, "description": change.description,
        "created_at": change.created_at,
    }
    return _replace_source("change", str(change.id), chunk_change(payload))


def sync_memory(memory: Any) -> bool:
    """Synchronize an AgentMemory entry."""
    payload = {
        "id": memory.id, "key": memory.key, "value": memory.value,
        "category": memory.category, "created_at": memory.created_at,
    }
    return _replace_source("memory", str(memory.id), chunk_memory(payload))


def get_source_vector_counts() -> dict[str, Any]:
    """Return live vector counts per source for the RAG administration panel."""
    coll = get_collection()
    source_map = {"runbooks": "runbook", "notes": "note", "changes": "change", "memories": "memory"}
    counts: dict[str, int] = {}
    for label, source in source_map.items():
        try:
            counts[label] = len(coll.get(where={"source": source}, include=[]).get("ids", []))
        except Exception as exc:
            logger.warning("RAG source count failed [%s]: %s", source, exc)
            counts[label] = 0
    return {"source_vector_counts": counts, "checked_at": datetime.now(timezone.utc).isoformat()}
