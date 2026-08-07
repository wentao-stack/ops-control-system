"""
RAG (Retrieval Augmented Generation) 引擎

基於 qwen3-embedding:0.6b (Ollama) + ChromaDB 本地向量庫。
索引來源: runbooks, notes, changes, agent_memories。
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

import chromadb
import httpx

logger = logging.getLogger(__name__)

# ── 配置 ──────────────────────────────────────────────────────────────

OLLAMA_EMBED_URL = os.getenv("OLLAMA_EMBED_URL", "http://127.0.0.1:11434/api/embed")
EMBED_MODEL = os.getenv("EMBED_MODEL", "qwen3-embedding:0.6b")
CHROMA_PERSIST_DIR = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), ".data", "chroma_db"
)
COLLECTION_NAME = "ops_rag"
EMBED_DIM = 1024  # qwen3-embedding:0.6b 輸出維度

# ── ChromaDB 實例（模組級單例） ───────────────────────────────────────

_client: Optional[Any] = None
_collection: Optional[Any] = None


def get_collection() -> Any:
    """獲取或創建 ChromaDB collection（單例）。"""
    global _client, _collection
    if _collection is not None:
        return _collection

    _client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
    try:
        _collection = _client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    except Exception:
        # 如果舊 collection 維度不匹配，刪除重建
        try:
            _client.delete_collection(COLLECTION_NAME)
        except Exception:
            pass
        _collection = _client.create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    return _collection


# ── Ollama Embedding ─────────────────────────────────────────────────

def embed_texts(texts: list[str]) -> list[list[float]]:
    """透過 Ollama API 生成 embedding 向量。"""
    payload = {"model": EMBED_MODEL, "input": texts}
    resp = httpx.post(OLLAMA_EMBED_URL, json=payload, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data["embeddings"]


# ── Chunking 策略 ────────────────────────────────────────────────────

def chunk_runbook(rb: dict) -> list[dict]:
    """Runbook 按步驟分割。"""
    chunks = []
    # 標題 + 描述作為第一個 chunk
    header = f"# {rb['title']}\n\n{rb['description']}"
    chunks.append({
        "text": header,
        "metadata": {
            "source": "runbook",
            "source_id": str(rb["id"]),
            "title": rb["title"],
            "category": rb.get("category", ""),
            "created_at": rb.get("created_at", "").isoformat() if isinstance(rb.get("created_at"), datetime) else str(rb.get("created_at", "")),
        },
    })
    # 每個 step 作為獨立 chunk
    steps = rb.get("steps", "")
    if steps:
        for i, step in enumerate(steps.strip().split("\n"), 1):
            step = step.strip()
            if step:
                chunks.append({
                    "text": f"步驟 {i}: {step}",
                    "metadata": {
                        "source": "runbook",
                        "source_id": str(rb["id"]),
                        "title": rb["title"],
                        "category": rb.get("category", ""),
                        "step": str(i),
                        "created_at": rb.get("created_at", "").isoformat() if isinstance(rb.get("created_at"), datetime) else str(rb.get("created_at", "")),
                    },
                })
    return chunks


def chunk_note(note: dict) -> list[dict]:
    """Note 按段落分割，超過 1024 字再切。"""
    chunks = []
    content = note.get("content", "")
    title = note.get("title", "")
    # 按雙換行分割段落
    paragraphs = content.split("\n\n")
    buffer = ""
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        if len(buffer) + len(p) > 1024 and buffer:
            chunks.append(_make_note_chunk(title, note, buffer))
            buffer = p
        else:
            buffer = (buffer + "\n\n" + p).strip() if buffer else p
    if buffer:
        chunks.append(_make_note_chunk(title, note, buffer))
    # 如果沒有段落，直接用全文
    if not chunks:
        chunks.append(_make_note_chunk(title, note, content))
    return chunks


def _make_note_chunk(title: str, note: dict, text: str) -> dict:
    return {
        "text": f"# {title}\n\n{text}",
        "metadata": {
            "source": "note",
            "source_id": str(note["id"]),
            "title": title,
            "category": note.get("category", ""),
            "created_at": note.get("created_at", "").isoformat() if isinstance(note.get("created_at"), datetime) else str(note.get("created_at", "")),
        },
    }


def chunk_change(ch: dict) -> list[dict]:
    """Change 全文作為一個 chunk。"""
    text = f"# {ch['title']}\n\n類型: {ch.get('change_type', '')}\n狀態: {ch.get('status', '')}\n\n{ch.get('description', '')}"
    return [{
        "text": text,
        "metadata": {
            "source": "change",
            "source_id": str(ch["id"]),
            "title": ch["title"],
            "category": ch.get("change_type", ""),
            "created_at": ch.get("created_at", "").isoformat() if isinstance(ch.get("created_at"), datetime) else str(ch.get("created_at", "")),
        },
    }]


def chunk_memory(mem: dict) -> list[dict]:
    """AgentMemory 全文作為一個 chunk。"""
    text = f"# {mem['key']}\n\n{mem['value']}"
    return [{
        "text": text,
        "metadata": {
            "source": "memory",
            "source_id": str(mem["id"]),
            "title": mem["key"],
            "category": mem.get("category", ""),
            "created_at": mem.get("created_at", "").isoformat() if isinstance(mem.get("created_at"), datetime) else str(mem.get("created_at", "")),
        },
    }]


# ── 索引建立 ──────────────────────────────────────────────────────────

def build_full_index(db_session) -> dict:
    """全量重建索引。返回統計信息。"""
    coll = get_collection()
    # 清空現有索引
    count = coll.count()
    if count > 0:
        existing_ids = coll.get(limit=count).get("ids", [])
        if existing_ids:
            coll.delete(ids=existing_ids)
    stats = {"runbooks": 0, "notes": 0, "changes": 0, "memories": 0, "total_chunks": 0, "total_vectors": 0}

    # ── Runbooks ──
    from .models import Runbook
    runbooks = db_session.query(Runbook).all()
    for rb in runbooks:
        rb_dict = {
            "id": rb.id, "title": rb.title, "category": rb.category,
            "description": rb.description, "steps": rb.steps,
            "created_at": rb.created_at,
        }
        chunks = chunk_runbook(rb_dict)
        stats["runbooks"] += 1
        _upsert_chunks(coll, chunks, stats)

    # ── Notes ──
    from .models import Note
    notes = db_session.query(Note).filter(Note.published == True).all()
    for n in notes:
        n_dict = {
            "id": n.id, "title": n.title, "category": n.category,
            "content": n.content, "created_at": n.created_at,
        }
        chunks = chunk_note(n_dict)
        stats["notes"] += 1
        _upsert_chunks(coll, chunks, stats)

    # ── Changes ──
    from .models import Change
    changes = db_session.query(Change).order_by(Change.created_at.desc()).limit(100).all()
    for ch in changes:
        ch_dict = {
            "id": ch.id, "title": ch.title, "change_type": ch.change_type,
            "status": ch.status, "description": ch.description,
            "created_at": ch.created_at,
        }
        chunks = chunk_change(ch_dict)
        stats["changes"] += 1
        _upsert_chunks(coll, chunks, stats)

    # ── AgentMemories ──
    from .models import AgentMemory
    memories = db_session.query(AgentMemory).all()
    for mem in memories:
        mem_dict = {
            "id": mem.id, "key": mem.key, "value": mem.value,
            "category": mem.category, "created_at": mem.created_at,
        }
        chunks = chunk_memory(mem_dict)
        stats["memories"] += 1
        _upsert_chunks(coll, chunks, stats)

    logger.info(f"RAG 索引完成: {stats}")
    return stats


def _upsert_chunks(coll, chunks: list[dict], stats: dict):
    """批量 upsert chunks 到 ChromaDB。"""
    if not chunks:
        return
    texts = [c["text"] for c in chunks]
    ids = [f"{c['metadata']['source']}:{c['metadata']['source_id']}:{i}" for i, c in enumerate(chunks)]
    metas = [c["metadata"] for c in chunks]

    try:
        vectors = embed_texts(texts)
        coll.upsert(ids=ids, documents=texts, metadatas=metas, embeddings=vectors)  # type: ignore[arg-type]
        stats["total_chunks"] += len(chunks)
        stats["total_vectors"] += len(vectors)
    except Exception as e:
        logger.error(f"RAG embedding 失敗: {e}")


def upsert_document(source: str, source_id: str, text: str, title: str, category: str = ""):
    """增量更新單一文檔。"""
    coll = get_collection()
    try:
        vectors = embed_texts([text])
        coll.upsert(
            ids=[f"{source}:{source_id}:0"],
            documents=[text],
            metadatas=[{"source": source, "source_id": str(source_id), "title": title, "category": category}],
            embeddings=vectors,  # type: ignore[arg-type]
        )
    except Exception as e:
        logger.error(f"RAG upsert 失敗 [{source}:{source_id}]: {e}")


# ── rag_search 工具 ──────────────────────────────────────────────────

def rag_search(query: str, source: str = "all", limit: int = 5) -> dict:
    """
    語義搜索知識庫。當用戶詢問具體問題、故障排查、SOP 時調用。

    Args:
        query: 搜索查詢（自然語言）
        source: 搜索範圍 — "all" | "runbooks" | "notes" | "changes" | "memories"
        limit: 返回結果數量 (1-10)

    Returns:
        包含搜索結果的字典
    """
    coll = get_collection()
    limit = min(max(limit, 1), 10)

    # 生成 query 向量
    try:
        vectors = embed_texts([query])
    except Exception as e:
        return {"query": query, "error": f"embedding 失敗: {e}", "results": []}

    # 構建 where 過濾
    where_filter = None
    source_map = {
        "runbooks": "runbook",
        "notes": "note",
        "changes": "change",
        "memories": "memory",
    }
    if source != "all" and source in source_map:
        where_filter = {"source": source_map[source]}

    # 向量搜索
    try:
        results = coll.query(
            query_embeddings=vectors,  # type: ignore[arg-type]
            n_results=limit,
            where=where_filter,  # type: ignore[arg-type]
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        return {"query": query, "error": f"搜索失敗: {e}", "results": []}

    # 格式化結果
    formatted = []
    ids = results.get("ids", [[]])[0]  # type: ignore[union-attr]
    docs = results.get("documents", [[]])[0]  # type: ignore[union-attr]
    metas = results.get("metadatas", [[]])[0]  # type: ignore[union-attr]
    dists = results.get("distances", [[]])[0]  # type: ignore[union-attr]

    for doc_id, doc, meta, dist in zip(ids, docs, metas, dists):
        # cosine distance → similarity (1 - distance)
        score = round(1 - dist, 4) if dist <= 2 else 0.0
        formatted.append({
            "source": meta.get("source", "unknown"),
            "source_id": meta.get("source_id", ""),
            "title": meta.get("title", ""),
            "category": meta.get("category", ""),
            "score": score,
            "content": doc[:2000],  # 截斷過長內容
        })

    return {
        "query": query,
        "source": source,
        "limit": limit,
        "results": formatted,
    }


# ── 健康檢查 ──────────────────────────────────────────────────────────

def get_index_stats() -> dict:
    """返回索引統計信息。"""
    coll = get_collection()
    count = coll.count()
    return {
        "collection": COLLECTION_NAME,
        "total_vectors": count,
        "persist_dir": CHROMA_PERSIST_DIR,
        "embed_model": EMBED_MODEL,
        "embed_dim": EMBED_DIM,
    }
