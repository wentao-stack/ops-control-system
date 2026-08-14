"""Tests for the deterministic RAG quality evaluation report."""

from app import rag_evaluation


def test_evaluation_reports_top_one_matches(monkeypatch):
    def fake_search(query: str, source: str, limit: int):
        case = next(item for item in rag_evaluation.EVALUATION_CASES if item["query"] == query)
        return {
            "results": [{
                "source": "runbook",
                "title": f"{case['expected_title']} 正式 SOP",
                "score": 0.91,
            }],
        }

    monkeypatch.setattr(rag_evaluation, "rag_search", fake_search)
    monkeypatch.setattr(rag_evaluation, "get_index_stats", lambda: {"total_vectors": 70})

    report = rag_evaluation.evaluate_runbook_retrieval()

    assert report["total"] == 12
    assert report["passed"] == 12
    assert report["pass_rate"] == 100.0
    assert all(item["source"] == "runbook" and item["passed"] for item in report["cases"])


def test_evaluation_keeps_empty_and_error_failures_visible(monkeypatch):
    monkeypatch.setattr(rag_evaluation, "rag_search", lambda *_args, **_kwargs: {"error": "embedding unavailable", "results": []})
    monkeypatch.setattr(rag_evaluation, "get_index_stats", lambda: {"total_vectors": 0})

    report = rag_evaluation.evaluate_runbook_retrieval()

    assert report["passed"] == 0
    assert report["pass_rate"] == 0.0
    assert all(item["error"] == "embedding unavailable" and not item["passed"] for item in report["cases"])
