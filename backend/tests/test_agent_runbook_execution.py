"""Regression tests for the guided Runbook execution tools."""

import asyncio
from datetime import UTC, datetime

from app.agent import build_system_prompt, tool_execute_runbook_step, tool_get_runbook_detail
from app.models import Change, Runbook


def test_get_runbook_detail_returns_steps(session):
    runbook = Runbook(
        title="Restart web service",
        category="web",
        description="Recover the web process safely.",
        steps="1. Check status\n2. Restart process\n3. Verify health",
        author="admin",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.add(runbook)
    session.commit()

    result = asyncio.run(tool_get_runbook_detail({"runbook_id": runbook.id, "_locale": "en"}, session))

    assert "Restart web service" in result
    assert "1. Check status" in result


def test_execute_runbook_step_requires_existing_runbook_and_records_change(session, monkeypatch):
    runbook = Runbook(
        title="Restart web service",
        category="web",
        description="Recover the web process safely.",
        steps="1. Restart process",
        author="admin",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.add(runbook)
    session.commit()

    async def fake_exec(params, _session):
        assert params["asset_id"] == "vultr"
        assert params["command"] == "supervisorctl restart nginx"
        return "✅ command completed"

    monkeypatch.setattr("app.agent.tool_exec_ssh_command", fake_exec)
    result = asyncio.run(tool_execute_runbook_step({
        "runbook_id": runbook.id,
        "step_name": "Restart process",
        "asset_id": "vultr",
        "command": "supervisorctl restart nginx",
        "_locale": "en",
    }, session))

    assert "command completed" in result
    change = session.query(Change).one()
    assert change.change_type == "maintenance"
    assert "Restart web service" in change.title


def test_execute_runbook_step_rejects_unknown_runbook(session):
    result = asyncio.run(tool_execute_runbook_step({
        "runbook_id": 999,
        "step_name": "Restart process",
        "asset_id": "vultr",
        "command": "supervisorctl restart nginx",
    }, session))

    assert "Runbook" in result


def test_system_prompt_requires_a_reviewed_runbook_and_post_execution_verification():
    prompt = build_system_prompt(locale="en")

    assert "get_runbook_detail" in prompt
    assert "execute_runbook_step" in prompt
    assert "驗證健康狀態" in prompt
