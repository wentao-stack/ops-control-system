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


def test_process_request_uses_controlled_process_tool():
    intent = agent_graph.detect_intent("在 wentao-MS-7C91 上看一下进程")
    assert intent is not None
    assert intent["function"]["name"] == "list_processes"
    assert json.loads(intent["function"]["arguments"])["asset_id"] == "wentao-MS-7C91"


def test_explicit_asset_status_request_is_bound_to_that_asset(session):
    from app.models import Asset

    session.add(Asset(
        id="asset-vultr", name="vultr (149.28.44.218)", asset_type="host",
        environment="production", owner="ops", criticality="high",
        health_status="healthy", ssh_host="149.28.44.218", ssh_port=22,
        ssh_user="root", local_machine=False, created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    ))
    session.commit()

    message = "vultr 看一下這台主機狀態"
    assert agent_graph._explicit_asset_id(session, message) == "asset-vultr"
    assert agent_graph._is_host_status_request(message)
    assert agent_graph._is_process_request("看一下 vultr 這台主機的進程")


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
