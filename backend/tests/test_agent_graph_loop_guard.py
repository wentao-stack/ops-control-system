"""Regression coverage for repeated read-tool calls in an Agent turn."""

import asyncio
import json
from datetime import UTC, datetime
from types import SimpleNamespace

from app import agent_graph
from app.agent_models import AgentConversation
from app.agent_schemas import AgentChatRequest


def _event(raw: str) -> dict:
    return json.loads(raw.removeprefix("data: ").strip())


def test_repeated_read_tool_forces_a_text_answer_instead_of_exhausting_iterations(session, monkeypatch):
    conversation = AgentConversation(
        id="conv-loop-guard",
        title="Test",
        model="test-model",
        user="admin",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.add(conversation)
    session.commit()

    executions = []
    tool_sets = []

    async def read_handler(params, _session):
        executions.append(params.copy())
        return "No matching Runbook"

    async def fake_llm(_model, _messages, tools):
        tool_sets.append(tools)
        if tools:
            return {
                "content": "",
                "tool_calls": [{
                    "id": f"call-{len(tool_sets)}",
                    "type": "function",
                    "function": {"name": "search_runbooks", "arguments": '{"query":"ops unavailable"}'},
                }],
            }
        return {"content": "I found no Runbook. Here is the diagnostic plan."}

    async def noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(agent_graph, "_llm_chat_with_tools", fake_llm)
    monkeypatch.setattr(agent_graph, "_get_tools_openai", lambda: [{"type": "function"}])
    monkeypatch.setattr(agent_graph, "_get_tool_handler", lambda _name: SimpleNamespace(requires_confirm=False, level="read", handler=read_handler))
    monkeypatch.setattr(agent_graph, "_check_tool_permission", lambda *_args: True)
    monkeypatch.setattr(agent_graph, "_save_message", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(agent_graph, "_record_tool_call", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(agent_graph, "_build_system_prompt", lambda *_args: "system")
    monkeypatch.setattr(agent_graph, "load_memories", lambda *_args: "")
    monkeypatch.setattr(agent_graph, "_auto_extract_memories", noop)

    async def collect():
        return [_event(raw) async for raw in agent_graph.run_agent_graph(
            session,
            AgentChatRequest(conversation_id=conversation.id, message="OPS unavailable", locale="en"),
            "admin",
        )]

    events = asyncio.run(collect())

    assert len(executions) == 1
    assert tool_sets[-1] == []
    assert not any(event["event"] == "warning" and "最大迭代" in event.get("message", "") for event in events)
    answer = "".join(event.get("token", "") for event in events if event["event"] == "token")
    assert "diagnostic plan" in answer
