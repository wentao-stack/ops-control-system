"""Regression coverage for RAG source citations exposed to the Agent."""

import asyncio

from app import agent, agent_rag


def test_rag_tool_emits_stable_citation_ids(monkeypatch):
    monkeypatch.setattr(agent_rag, "rag_search", lambda **_: {
        "results": [
            {
                "source": "runbook",
                "source_id": "rb-nginx-502",
                "title": "Nginx 502 / upstream 異常",
                "score": 0.91,
                "content": "先確認 upstream 健康狀態。",
            },
            {
                "source": "note",
                "source_id": "42",
                "title": "部署經驗筆記",
                "score": 0.76,
                "content": "保留上一版 build 以便回滾。",
            },
        ],
    })

    result = asyncio.run(agent.tool_rag_search({"query": "Nginx 502"}, session=object()))

    assert "可引用來源" in result
    assert "[R1] 📕 [runbook] Nginx 502 / upstream 異常" in result
    assert "[R2] 📝 [note] 部署經驗筆記" in result
    assert "[R1] 先確認 upstream 健康狀態。" in result
    assert "[R2] 保留上一版 build 以便回滾。" in result


def test_system_prompt_requires_rag_citations():
    prompt = agent.build_system_prompt(locale="zh-TW")

    assert "[R1]" in prompt
    assert "引用來源" in prompt
