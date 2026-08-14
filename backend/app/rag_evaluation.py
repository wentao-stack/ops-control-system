"""Deterministic retrieval checks for the curated operational Runbook catalog."""

from __future__ import annotations

import time
from typing import TypedDict

from .agent_rag import get_index_stats, rag_search


class EvaluationCase(TypedDict):
    id: str
    query: str
    expected_title: str


EVALUATION_CASES: tuple[EvaluationCase, ...] = (
    {"id": "ops-zh", "query": "OPS 控制台打不開，請給我診斷計畫", "expected_title": "OPS 控制台無法存取"},
    {"id": "nginx-en", "query": "nginx returns 502 upstream error", "expected_title": "Nginx 502"},
    {"id": "frp-ja", "query": "FRP トンネルが切断されました", "expected_title": "FRP 隧道中斷"},
    {"id": "comfy-en", "query": "ComfyUI queue stuck and GPU task does not start", "expected_title": "ComfyUI 服務"},
    {"id": "disk-zh", "query": "伺服器磁碟超過 85%，如何安全清理", "expected_title": "磁碟空間超過閾值"},
    {"id": "supervisor-en", "query": "Supervisor process is in BACKOFF and keeps restarting", "expected_title": "Supervisor 服務"},
    {"id": "backup-zh", "query": "SQLite 資料庫誤刪資料，需要從備份還原", "expected_title": "SQLite 資料庫備份"},
    {"id": "rollback-en", "query": "deployment caused 5xx errors, how do I roll back safely", "expected_title": "OPS 部署失敗"},
    {"id": "tls-en", "query": "TLS certificate expired and HTTPS handshake fails", "expected_title": "TLS 握手異常"},
    {"id": "ssh-en", "query": "SSH Permission denied on a production server", "expected_title": "SSH 連線失敗"},
    {"id": "sqlite-en", "query": "SQLite database is locked and WAL file keeps growing", "expected_title": "SQLite 完整性異常"},
    {"id": "scheduler-en", "query": "backup scheduler failed and no new backup was created", "expected_title": "備份排程失敗"},
)


def evaluate_runbook_retrieval() -> dict:
    """Run the curated multilingual query set without rebuilding the RAG index."""
    results: list[dict] = []
    for case in EVALUATION_CASES:
        started = time.perf_counter()
        response = rag_search(case["query"], source="runbooks", limit=1)
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        hits = response.get("results", [])
        hit = hits[0] if hits else {}
        actual_title = hit.get("title", "")
        error = response.get("error")
        passed = not error and case["expected_title"] in actual_title
        results.append({
            **case,
            "actual_title": actual_title,
            "source": hit.get("source", ""),
            "score": hit.get("score"),
            "elapsed_ms": elapsed_ms,
            "passed": passed,
            "error": error,
        })

    passed = sum(result["passed"] for result in results)
    total = len(results)
    return {
        "index_stats": get_index_stats(),
        "total": total,
        "passed": passed,
        "pass_rate": round((passed / total) * 100, 1) if total else 0.0,
        "cases": results,
    }
