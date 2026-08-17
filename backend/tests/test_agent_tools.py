"""Unit tests for Phase 1 write tools and existing read tools.

Tests run against an in-memory SQLite DB (no SSH, no LLM calls).
"""
from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from app.agent import (
    get_tool_handler,
    get_tools_openai,
    register_tool,
    _tools,
)
from app.models import (
    Alert,
    Asset,
    Change,
    ExecLog,
    Note,
    Runbook,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

async def invoke_tool(name: str, params: dict, session):
    """Resolve a registered tool and call its handler."""
    td = get_tool_handler(name)
    assert td is not None, f"Tool {name!r} not registered"
    return await td.handler(params, session)


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture()
def prod_asset(session):
    a = Asset(
        id="asset-prod-vps",
        name="archlinux (163.44.124.142)",
        asset_type="server",
        environment="prod",
        owner="wentao",
        criticality="high",
        health_status="healthy",
        health_summary="All systems operational",
        ssh_host="163.44.124.142",
        ssh_port=22,
        ssh_user="wentao",
        local_machine=False,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.add(a)
    session.commit()
    return a


@pytest.fixture()
def local_asset(session):
    a = Asset(
        id="asset-local",
        name="local-machine",
        asset_type="server",
        environment="dev",
        owner="wentao",
        criticality="low",
        health_status="healthy",
        ssh_host=None,
        ssh_port=None,
        ssh_user=None,
        local_machine=True,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.add(a)
    session.commit()
    return a


@pytest.fixture()
def sample_alert(session):
    a = Alert(
        title="CPU 使用率過高",
        severity="warning",
        source="monitor",
        message="CPU 使用率達到 95%",
        acknowledged=False,
        created_at=datetime.now(UTC),
    )
    session.add(a)
    session.commit()
    return a


@pytest.fixture()
def sample_runbook(session):
    r = Runbook(
        title="重啟 Nginx",
        category="web",
        description="標準 Nginx 重啟流程",
        steps="1. systemctl status nginx\n2. systemctl restart nginx\n3. 確認端口監聽",
        author="wentao",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.add(r)
    session.commit()
    return r


# ── Tool Registry Tests ─────────────────────────────────────────────────────

class TestToolRegistry:
    def test_all_phase1_tools_registered(self):
        names = [t.name for t in _tools]
        for tool_name in [
            "exec_ssh_command",
            "supervisor_action",
            "create_note",
            "acknowledge_alert",
            "search_runbooks",
        ]:
            assert tool_name in names, f"{tool_name} not in registry"

    def test_read_tools_registered(self):
        names = [t.name for t in _tools]
        for tool_name in [
            "get_host_metrics",
            "list_assets",
            "check_services",
            "get_alerts",
            "search_notes",
            "get_changes",
        ]:
            assert tool_name in names

    def test_requires_confirm_flags(self):
        exec_tool = get_tool_handler("exec_ssh_command")
        sup_tool = get_tool_handler("supervisor_action")
        note_tool = get_tool_handler("create_note")
        alert_tool = get_tool_handler("acknowledge_alert")

        assert exec_tool is not None and exec_tool.requires_confirm is True
        assert sup_tool is not None and sup_tool.requires_confirm is True
        assert note_tool is not None and note_tool.requires_confirm is False
        assert alert_tool is not None and alert_tool.requires_confirm is False

    def test_openai_format(self):
        tools = get_tools_openai()
        assert len(tools) >= 11
        for t in tools:
            assert t["type"] == "function"
            assert "name" in t["function"]
            assert "parameters" in t["function"]
            assert "description" in t["function"]

    def test_controlled_diagnostic_tools_are_read_only(self):
        for name in ["get_service_logs", "check_disk_usage", "check_deployment_status", "list_processes"]:
            tool = get_tool_handler(name)
            assert tool is not None
            assert tool.level == "read"
            assert tool.requires_confirm is False


# ── exec_ssh_command ────────────────────────────────────────────────────────

class TestExecSSHCommand:
    async def test_command_too_long(self, session):
        res = await invoke_tool("exec_ssh_command", {"asset_id": "x", "command": "a" * 501}, session)
        assert "1-500" in res

    async def test_empty_command(self, session):
        res = await invoke_tool("exec_ssh_command", {"asset_id": "x", "command": ""}, session)
        assert "1-500" in res

    async def test_asset_not_found(self, session):
        res = await invoke_tool("exec_ssh_command", {"asset_id": "nonexistent", "command": "echo hi"}, session)
        assert "找不到" in res

    async def test_asset_no_ssh(self, session):
        """Asset without ssh_host and not local_machine should fail."""
        a = Asset(
            id="asset-no-ssh",
            name="no-ssh-host",
            asset_type="server",
            environment="prod",
            owner="wentao",
            criticality="low",
            health_status="healthy",
            ssh_host=None,
            ssh_port=None,
            ssh_user=None,
            local_machine=False,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        session.add(a)
        session.commit()
        res = await invoke_tool("exec_ssh_command", {"asset_id": a.id, "command": "echo hi"}, session)
        assert "沒有配置 SSH" in res

    async def test_asset_name_lookup(self, session, prod_asset):
        """Tool should resolve by asset name as well as ID."""
        # Since we can't actually SSH, the tool will try and fail at SSH level,
        # but it should NOT fail at the asset-lookup stage.
        res = await invoke_tool("exec_ssh_command", {"asset_id": prod_asset.name, "command": "echo hi"}, session)
        # Should not be "找不到資產"
        assert "找不到資產" not in res

    async def test_generic_shell_is_blocked_in_production(self, session, prod_asset):
        res = await invoke_tool("exec_ssh_command", {"asset_id": prod_asset.id, "command": "echo hi"}, session)
        assert "生產環境" in res


class TestControlledDiagnostics:
    async def test_rejects_unsafe_service_name(self, session):
        res = await invoke_tool("get_service_logs", {"asset_id": "x", "service": "nginx; rm -rf /"}, session)
        assert "無效" in res

    async def test_rejects_relative_disk_path(self, session):
        res = await invoke_tool("check_disk_usage", {"asset_id": "x", "path": "../tmp"}, session)
        assert "絕對路徑" in res

    async def test_process_tool_rejects_unknown_sort(self, session):
        res = await invoke_tool("list_processes", {"asset_id": "x", "sort_by": "pid"}, session)
        assert "sort_by" in res


# ── supervisor_action ───────────────────────────────────────────────────────

class TestSupervisorAction:
    async def test_invalid_action(self, session, prod_asset):
        res = await invoke_tool(
            "supervisor_action",
            {"asset_id": prod_asset.id, "process_name": "ocs-backend", "action": "invalid"},
            session,
        )
        assert "start" in res and "stop" in res and "restart" in res

    async def test_asset_not_found(self, session):
        res = await invoke_tool(
            "supervisor_action",
            {"asset_id": "nonexistent", "process_name": "x", "action": "restart"},
            session,
        )
        assert "找不到" in res

    async def test_asset_name_lookup(self, session, prod_asset):
        """Resolve by asset name."""
        res = await invoke_tool(
            "supervisor_action",
            {"asset_id": prod_asset.name, "process_name": "ocs-backend", "action": "restart"},
            session,
        )
        assert "找不到資產" not in res

    async def test_records_change_on_success(self, session, prod_asset, monkeypatch):
        """When supervisor_action_impl succeeds, a Change record is created."""
        from app.models import Change as MChange

        class FakeResult:
            success = True
            message = "ok"

        monkeypatch.setattr("app.agent.supervisor_action_impl", lambda *a, **kw: FakeResult())

        await invoke_tool(
            "supervisor_action",
            {"asset_id": prod_asset.id, "process_name": "ocs-backend", "action": "restart", "_actor": "wentao"},
            session,
        )

        changes = session.query(MChange).all()
        assert len(changes) == 1
        assert "restart" in changes[0].title
        assert changes[0].change_type == "config"
        assert changes[0].author == "wentao"


# ── create_note ─────────────────────────────────────────────────────────────

class TestCreateNote:
    async def test_empty_title(self, session):
        res = await invoke_tool("create_note", {"title": "", "content": "hello"}, session)
        assert "標題" in res and "空" in res

    async def test_empty_content(self, session):
        res = await invoke_tool("create_note", {"title": "t", "content": ""}, session)
        assert "內容" in res and "空" in res

    async def test_create_success(self, session):
        res = await invoke_tool(
            "create_note",
            {"title": "測試筆記", "content": "# Hello\n\nThis is a test.", "category": "測試"},
            session,
        )
        assert "已創建" in res
        assert "測試筆記" in res
        assert "測試" in res

        note = session.query(Note).filter_by(title="測試筆記").first()
        assert note is not None
        assert note.author == "agent"
        assert note.category == "測試"

    async def test_create_uses_authenticated_actor(self, session):
        """The note author must be the authenticated user, never a model-supplied value."""
        res = await invoke_tool(
            "create_note",
            {"title": "actor note", "content": "body", "_actor": "wentao"},
            session,
        )
        assert "已創建" in res
        note = session.query(Note).filter_by(title="actor note").first()
        assert note is not None
        assert note.author == "wentao"

    async def test_create_with_tags(self, session):
        await invoke_tool(
            "create_note",
            {"title": "tagged", "content": "body", "tags": ["a", "b"]},
            session,
        )
        note = session.query(Note).filter_by(title="tagged").first()
        assert json.loads(note.tags) == ["a", "b"]

    async def test_default_category(self, session):
        await invoke_tool("create_note", {"title": "default cat", "content": "body"}, session)
        note = session.query(Note).filter_by(title="default cat").first()
        assert note.category == "知識"


# ── acknowledge_alert ───────────────────────────────────────────────────────

class TestAcknowledgeAlert:
    async def test_missing_alert_id(self, session):
        res = await invoke_tool("acknowledge_alert", {"alert_id": None}, session)
        assert "提供" in res or "請" in res

    async def test_alert_not_found(self, session):
        res = await invoke_tool("acknowledge_alert", {"alert_id": 99999}, session)
        assert "找不到" in res

    async def test_acknowledge_success(self, session, sample_alert):
        aid = sample_alert.id
        res = await invoke_tool("acknowledge_alert", {"alert_id": aid, "_actor": "wentao"}, session)
        assert "已確認" in res

        session.expire_on_commit = False
        alert = session.get(Alert, aid)
        assert alert.acknowledged is True
        assert alert.acknowledged_by == "wentao"

    async def test_double_acknowledge(self, session, sample_alert):
        aid = sample_alert.id
        await invoke_tool("acknowledge_alert", {"alert_id": aid}, session)
        res2 = await invoke_tool("acknowledge_alert", {"alert_id": aid}, session)
        assert "已被確認" in res2


# ── search_runbooks ─────────────────────────────────────────────────────────

class TestSearchRunbooks:
    async def test_empty_db(self, session):
        res = await invoke_tool("search_runbooks", {}, session)
        assert "沒有找到" in res

    async def test_search_by_query(self, session, sample_runbook):
        res = await invoke_tool("search_runbooks", {"query": "Nginx"}, session)
        assert "Nginx" in res

    async def test_search_by_category(self, session, sample_runbook):
        res = await invoke_tool("search_runbooks", {"category": "web"}, session)
        assert "Nginx" in res

    async def test_no_match(self, session, sample_runbook):
        res = await invoke_tool("search_runbooks", {"query": "zzzznotexist"}, session)
        assert "沒有找到" in res


# ── Read tool smoke tests (no SSH needed) ───────────────────────────────────

class TestReadTools:
    async def test_list_assets_empty(self, session):
        res = await invoke_tool("list_assets", {}, session)
        assert "沒有找到" in res

    async def test_list_assets_with_filter(self, session, prod_asset):
        res = await invoke_tool("list_assets", {"environment": "prod"}, session)
        assert "1 個資產" in res
        assert "archlinux" in res

        res2 = await invoke_tool("list_assets", {"environment": "dev"}, session)
        assert "沒有找到" in res2

    async def test_get_alerts_empty(self, session):
        res = await invoke_tool("get_alerts", {}, session)
        assert "沒有告警" in res

    async def test_get_alerts_with_severity(self, session, sample_alert):
        res = await invoke_tool("get_alerts", {"severity": "warning"}, session)
        assert "1 個告警" in res
        assert "CPU" in res

    async def test_search_notes_empty(self, session):
        res = await invoke_tool("search_notes", {}, session)
        assert "沒有找到" in res

    async def test_get_changes_empty(self, session):
        res = await invoke_tool("get_changes", {}, session)
        assert "沒有變更" in res


# ── exec_log recording ──────────────────────────────────────────────────────

class TestExecLogRecording:
    async def test_exec_log_created_on_local(self, session, local_asset):
        """When command runs on local_machine, ExecLog is recorded."""
        res = await invoke_tool(
            "exec_ssh_command",
            {"asset_id": local_asset.id, "command": "echo test"},
            session,
        )
        # Verify command actually ran
        assert "在 local-machine 上執行命令" in res
        assert "echo test" in res
        # tool_exec_ssh_command calls session.commit() inside asyncio.to_thread context.
        # The commit may be in a different transaction view. Query the engine directly.
        from sqlalchemy import text
        row = session.execute(text("SELECT COUNT(*) FROM exec_log WHERE command = 'echo test'")).scalar()
        assert row >= 1, f"Expected at least 1 exec_log row, got {row}"
