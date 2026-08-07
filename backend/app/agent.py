from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from dotenv import load_dotenv
from sqlalchemy import func, select
from sqlalchemy.orm import Session

# Load .env from project root
_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

from .agent_models import AgentConversation, AgentMessage
from .agent_schemas import (
    AgentChatRequest,
    AgentConversationCreate,
    AgentConversationResponse,
    AgentConversationListResponse,
    AgentHealthResponse,
    AgentMessageResponse,
    AgentMessagesListResponse,
)

# ── LLM config ──────────────────────────────────────────────────────────────

LLM_API_KEY = os.getenv("OPENAI_API_KEY", "")
LLM_BASE_URL = os.getenv("OPENAI_BASE_URL", "http://127.0.0.1:9292/v1")
DEFAULT_MODEL = os.getenv("AGENT_DEFAULT_MODEL", "qwen36-27b-no-think-v1")

# ── Tool Registry ───────────────────────────────────────────────────────────


class ToolDef:
    """A single tool definition with name, description, JSON schema params, and handler."""

    def __init__(self, name: str, description: str, params_schema: dict[str, Any], handler, requires_confirm: bool = False, level: str = "read"):
        self.name = name
        self.description = description
        self.params_schema = params_schema  # JSON Schema object for the tool
        self.handler = handler  # async callable(params: dict, session: Session) -> str
        self.requires_confirm = requires_confirm
        self.level = level  # "read" | "write" | "exec"

    def to_openai(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.params_schema,
            },
        }


# Global tool registry
_tools: list[ToolDef] = []


def register_tool(name: str, description: str, params_schema: dict[str, Any], requires_confirm: bool = False, level: str = "read"):
    """Decorator to register a tool."""
    def wrapper(fn):
        _tools.append(ToolDef(name, description, params_schema, fn, requires_confirm, level))
        return fn
    return wrapper


def get_tools_openai() -> list[dict]:
    """Return all tools in OpenAI function-calling format."""
    return [t.to_openai() for t in _tools]


def get_tool_handler(name: str) -> ToolDef | None:
    for t in _tools:
        if t.name == name:
            return t
    return None


# ── Permission & audit helpers ───────────────────────────────────────────────

# Permission hierarchy: admin can do everything; viewer can only read
_ROLE_PERMISSIONS: dict[str, set[str]] = {
    "admin": {"read", "write", "exec"},
    "viewer": {"read"},
}


def check_tool_permission(user_role: str, tool_level: str) -> bool:
    """Check if a user role has permission to use a tool at a given level."""
    allowed = _ROLE_PERMISSIONS.get(user_role, {"read"})
    return tool_level in allowed


def record_tool_call(
    session: Session,
    conv_id: str,
    user: str,
    tool_name: str,
    tool_level: str,
    tool_input: str,
    tool_result: str,
    confirmed: bool = False,
    confirmed_by: str | None = None,
):
    """Record a tool call in the audit log."""
    from .models import AgentToolCall
    from datetime import UTC, datetime

    now = datetime.now(UTC).replace(microsecond=0)
    call = AgentToolCall(
        conversation_id=conv_id,
        user=user,
        tool_name=tool_name,
        tool_level=tool_level,
        tool_input=tool_input,
        tool_result=tool_result,
        confirmed=confirmed,
        confirmed_by=confirmed_by if confirmed else None,
        confirmed_at=now if confirmed else None,
        created_at=now,
    )
    session.add(call)
    session.commit()


# ── Tool Definitions ────────────────────────────────────────────────────────


@register_tool(
    name="get_host_metrics",
    description="獲取所有遠程主機的監控數據（CPU、記憶體、磁碟、GPU）。當用戶詢問主機狀態、監控、資源使用時使用。",
    params_schema={
        "type": "object",
        "properties": {},
        "required": [],
    },
)
async def tool_get_host_metrics(params: dict, session: Session) -> str:
    """Collect metrics from all remote hosts via SSH."""
    from .remote_monitor import collect_remote_metrics, save_metrics_to_history
    from .models import Asset
    import asyncio

    assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()
    if not assets:
        return "沒有配置 SSH 連線的主機"

    async def _collect(asset: Asset) -> dict:
        raw = await asyncio.to_thread(
            collect_remote_metrics,
            host=asset.ssh_host,
            port=asset.ssh_port or 22,
            user=asset.ssh_user,
            asset_id=asset.id,
            name=asset.name,
            timeout=60,
        )
        # Save to history
        await asyncio.to_thread(save_metrics_to_history, raw)
        return {
            "asset_id": raw.asset_id,
            "name": raw.name,
            "cpu_percent": getattr(raw, "cpu_percent", None),
            "cpu_count": getattr(raw, "cpu_count", None),
            "mem_total_mb": getattr(raw, "mem_total_mb", None),
            "mem_used_mb": getattr(raw, "mem_used_mb", None),
            "mem_percent": getattr(raw, "mem_percent", None),
            "disk_total_gb": getattr(raw, "disk_total_gb", None),
            "disk_used_gb": getattr(raw, "disk_used_gb", None),
            "disk_percent": getattr(raw, "disk_percent", None),
            "gpu": getattr(raw, "gpu", []),
        }

    results = await asyncio.gather(*[_collect(a) for a in assets], return_exceptions=True)
    lines = []
    for r in results:
        if isinstance(r, Exception):
            lines.append(f"錯誤: {r}")
        else:
            d = r
            lines.append(f"📊 {d['name']} ({d['asset_id']})")
            if d.get("cpu_percent") is not None:
                lines.append(f"  CPU: {d['cpu_percent']}% ({d.get('cpu_count', '?')} cores)")
            if d.get("mem_percent") is not None:
                lines.append(f"  記憶體: {d['mem_used_mb']}MB / {d['mem_total_mb']}MB ({d['mem_percent']}%)")
            if d.get("disk_percent") is not None:
                lines.append(f"  磁碟: {d['disk_used_gb']}GB / {d['disk_total_gb']}GB ({d['disk_percent']}%)")
            if d.get("gpu"):
                for g in d["gpu"]:
                    lines.append(f"  GPU: {g}")
            lines.append("")
    return "\n".join(lines) if lines else "無法收集監控數據"


@register_tool(
    name="list_assets",
    description="列出所有資產（主機、服務、網路設備等）。支援按環境和狀態篩選。當用戶詢問資產、主機列表、伺服器清單時使用。",
    params_schema={
        "type": "object",
        "properties": {
            "environment": {
                "type": "string",
                "enum": ["dev", "staging", "prod"],
                "description": "環境篩選 (dev/staging/prod)",
            },
            "health_status": {
                "type": "string",
                "enum": ["healthy", "degraded", "down"],
                "description": "健康狀態篩選",
            },
        },
        "required": [],
    },
)
async def tool_list_assets(params: dict, session: Session) -> str:
    """List all assets with optional filters."""
    from .models import Asset

    q = select(Asset)
    env = params.get("environment")
    health = params.get("health_status")
    if env:
        q = q.where(Asset.environment == env)
    if health:
        q = q.where(Asset.health_status == health)

    assets = session.scalars(q.order_by(Asset.name)).all()
    if not assets:
        return "沒有找到資產"

    lines = [f"📋 共 {len(assets)} 個資產"]
    for a in assets:
        status_icon = {"healthy": "🟢", "degraded": "🟡", "down": "🔴"}.get(a.health_status, "⚪")
        lines.append(f"  {status_icon} {a.name} [{a.environment}] — {a.health_summary or a.asset_type or '無描述'}")
    return "\n".join(lines)


@register_tool(
    name="check_services",
    description="偵測所有遠程主機上運行的服務（systemd、Docker、進程）。當用戶詢問服務狀態、運行中的服務時使用。",
    params_schema={
        "type": "object",
        "properties": {},
        "required": [],
    },
)
async def tool_check_services(params: dict, session: Session) -> str:
    """Detect services on all remote hosts."""
    from .remote_service import detect_remote_services
    from .models import Asset
    import asyncio

    assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()
    if not assets:
        return "沒有配置 SSH 連線的主機"

    async def _detect(asset: Asset) -> str:
        result = await asyncio.to_thread(
            detect_remote_services,
            host=asset.ssh_host,
            port=asset.ssh_port or 22,
            user=asset.ssh_user,
            asset_id=asset.id,
            name=asset.name,
            timeout=60,
        )
        lines = [f"📊 {asset.name} ({asset.ssh_host})"]
        if result:
            for s in result[:15]:  # limit display
                lines.append(f"  ● {s.name} ({s.service_type}) — {s.description or '無描述'}")
        else:
            lines.append("  沒有偵測到服務")
        return "\n".join(lines)

    results = await asyncio.gather(*[_detect(a) for a in assets], return_exceptions=True)
    output = []
    for r in results:
        if isinstance(r, Exception):
            output.append(f"錯誤: {r}")
        else:
            output.append(r)
    output.append("")
    return "\n".join(output)


@register_tool(
    name="get_alerts",
    description="獲取系統告警列表。支援按嚴重程度篩選。當用戶詢問告警、警報、異常時使用。",
    params_schema={
        "type": "object",
        "properties": {
            "severity": {
                "type": "string",
                "enum": ["critical", "warning", "info"],
                "description": "嚴重程度篩選",
            },
        },
        "required": [],
    },
)
async def tool_get_alerts(params: dict, session: Session) -> str:
    """List alerts with optional severity filter."""
    from .models import Alert

    q = select(Alert).order_by(Alert.created_at.desc())
    sev = params.get("severity")
    if sev:
        q = q.where(Alert.severity == sev)

    alerts = session.scalars(q.limit(50)).all()
    if not alerts:
        return "沒有告警"

    icon = {"critical": "🔴", "warning": "🟡", "info": "🔵"}
    lines = [f"🚨 共 {len(alerts)} 個告警"]
    for a in alerts:
        ack = "✅" if a.acknowledged else "⏳"
        lines.append(f"  {icon.get(a.severity, '⚪')} {ack} [{a.severity}] {a.message}")
    return "\n".join(lines)


@register_tool(
    name="search_notes",
    description="搜索筆記內容。支援按關鍵字、分類搜索。當用戶詢問筆記、文檔、記錄時使用。",
    params_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "搜索關鍵字",
            },
            "category": {
                "type": "string",
                "description": "分類篩選",
            },
        },
        "required": [],
    },
)
async def tool_search_notes(params: dict, session: Session) -> str:
    """Search notes by keyword or category."""
    from .models import Note

    q = select(Note).order_by(Note.updated_at.desc())
    query = params.get("query", "")
    category = params.get("category", "")

    if query:
        q = q.where(Note.title.ilike(f"%{query}%") | Note.content.ilike(f"%{query}%"))
    if category:
        q = q.where(Note.category == category)

    notes = session.scalars(q.limit(20)).all()
    if not notes:
        return "沒有找到筆記"

    lines = [f"📝 找到 {len(notes)} 筆筆記"]
    for n in notes:
        lines.append(f"  📄 [{n.category}] {n.title}")
        # Show first 80 chars of content
        preview = n.content[:80].replace("\n", " ")
        if len(n.content) > 80:
            preview += "..."
        lines.append(f"     {preview}")
    return "\n".join(lines)


@register_tool(
    name="get_changes",
    description="獲取變更記錄。支援按類型和狀態篩選。當用戶詢問變更、部署、維護記錄時使用。",
    params_schema={
        "type": "object",
        "properties": {
            "change_type": {
                "type": "string",
                "enum": ["deploy", "config", "incident", "maintenance", "infra"],
                "description": "變更類型篩選",
            },
        },
        "required": [],
    },
)
async def tool_get_changes(params: dict, session: Session) -> str:
    """List changes with optional type filter."""
    from .models import Change

    q = select(Change).order_by(Change.created_at.desc())
    ctype = params.get("change_type")
    if ctype:
        q = q.where(Change.change_type == ctype)

    changes = session.scalars(q.limit(30)).all()
    if not changes:
        return "沒有變更記錄"

    lines = [f"📋 共 {len(changes)} 筆變更記錄"]
    for c in changes:
        lines.append(f"  [{c.change_type}] {c.description} — {c.status} — {c.created_at.strftime('%Y-%m-%d %H:%M')}")
    return "\n".join(lines)


# ── Phase 1: Write/Execute Tools ────────────────────────────────────────────


@register_tool(
    name="exec_ssh_command",
    description="在遠端主機上執行 Shell 命令。需要用戶確認。當用戶要求執行命令、安裝軟體、重啟服務等寫入操作時使用。",
    params_schema={
        "type": "object",
        "properties": {
            "asset_id": {
                "type": "string",
                "description": "資產 ID 或名稱（如 archlinux、vultr）",
            },
            "command": {
                "type": "string",
                "description": "要執行的 Shell 命令（限 500 字元）",
            },
            "timeout": {
                "type": "integer",
                "description": "超時秒數（預設 60）",
                "default": 60,
            },
        },
        "required": ["asset_id", "command"],
    },
    requires_confirm=True,
    level="exec",
)
async def tool_exec_ssh_command(params: dict, session: Session) -> str:
    """Execute a shell command on a remote host via SSH. Requires frontend confirmation."""
    from .remote import ssh_exec
    from .models import Asset, ExecLog

    asset_id = params.get("asset_id", "")
    command = params.get("command", "")
    timeout = params.get("timeout", 60)

    if not command or len(command) > 500:
        return "❌ 命令長度必須在 1-500 字元之間"

    # Command blacklist — dangerous commands that should never be executed
    _DANGEROUS_CMDS = [
        "rm -rf /", "rm -rf /*", "mkfs", "dd if=", "fdisk",
        ":(){:|:};", "curl.*|.*bash", "wget.*|.*bash",
        "chmod -R 777", "chown -R",
    ]
    import re as _re
    cmd_lower = command.lower().strip()
    for pattern in _DANGEROUS_CMDS:
        if _re.search(pattern, cmd_lower):
            return f"❌ 命令包含危險操作，已被黑名單阻擋: {command[:80]}"

    asset = session.execute(
        select(Asset).where(
            (Asset.id == asset_id) | (Asset.name == asset_id)
        )
    ).scalar_one_or_none()

    # Fuzzy match: if exact match failed, try partial name match (e.g. "vultr" → "vultr (149.28.44.218)")
    if not asset:
        asset = session.execute(
            select(Asset).where(Asset.name.like(f"%{asset_id}%"))
        ).scalar_one_or_none()

    if not asset:
        # Show available assets with SSH to help LLM retry
        ssh_assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()
        if ssh_assets:
            names = ", ".join(f"{a.name}({a.ssh_host})" for a in ssh_assets)
            return f"❌ 找不到資產 '{asset_id}'。可用資產: {names}"
        return f"❌ 找不到資產 '{asset_id}'"
    if not asset.local_machine and not asset.ssh_host:
        return f"❌ 資產 {asset.name} 沒有配置 SSH"
    if not asset.local_machine and not asset.ssh_user:
        return f"❌ 資產 {asset.name} 沒有配置 SSH 用戶"

    import asyncio
    import time as _time

    start = _time.monotonic()
    if asset.local_machine:
        from .remote_supervisor import _local_exec
        result = await asyncio.to_thread(_local_exec, command, timeout=timeout)
    else:
        assert asset.ssh_host is not None and asset.ssh_user is not None
        result = await asyncio.to_thread(
            ssh_exec,
            host=asset.ssh_host,
            port=asset.ssh_port or 22,
            user=asset.ssh_user,
            command=command,
            timeout=timeout,
        )
    duration = round(_time.monotonic() - start, 2)

    # Record to exec_log
    now = datetime.now(UTC).replace(microsecond=0)
    log = ExecLog(
        asset_id=asset_id,
        command=command,
        stdout=result.get("stdout", "")[:5000],
        stderr=result.get("stderr", "")[:5000],
        exit_code=result.get("exit_code", -1),
        duration=duration,
        user="agent",
        created_at=now,
    )
    session.add(log)
    session.commit()

    exit_icon = "✅" if result.get("exit_code") == 0 else "❌"
    lines = [f"{exit_icon} 在 {asset.name} 上執行命令"]
    lines.append(f"  命令: {command}")
    lines.append(f"  退出碼: {result.get('exit_code')}")
    lines.append(f"  耗時: {duration}s")
    stdout = result.get("stdout", "").strip()
    stderr = result.get("stderr", "").strip()
    if stdout:
        lines.append(f"  輸出: {stdout[:500]}")
    if stderr:
        lines.append(f"  錯誤: {stderr[:500]}")
    return "\n".join(lines)


@register_tool(
    name="supervisor_action",
    description="管理遠端主機的 Supervisor 程序（start/stop/restart）。需要用戶確認。當用戶要求重啟程序、停止服務等 Supervisor 操作時使用。",
    params_schema={
        "type": "object",
        "properties": {
            "asset_id": {
                "type": "string",
                "description": "資產 ID 或名稱（如 archlinux、vultr）",
            },
            "process_name": {
                "type": "string",
                "description": "Supervisor 程序名稱（必填）",
            },
            "action": {
                "type": "string",
                "enum": ["start", "stop", "restart"],
                "description": "操作類型（必填）",
            },
        },
        "required": ["asset_id", "process_name", "action"],
    },
    requires_confirm=True,
    level="exec",
)
async def tool_supervisor_action(params: dict, session: Session) -> str:
    """Execute a supervisor action on a remote host. Requires frontend confirmation."""
    from .models import Asset, Change

    asset_id = params.get("asset_id", "")
    process_name = params.get("process_name", "")
    action = params.get("action", "")

    if action not in ("start", "stop", "restart"):
        return "❌ 操作必須是 start、stop 或 restart"

    asset = session.execute(
        select(Asset).where(
            (Asset.id == asset_id) | (Asset.name == asset_id)
        )
    ).scalar_one_or_none()

    # Fuzzy match: if exact match failed, try partial name match (e.g. "vultr" → "vultr (149.28.44.218)")
    if not asset:
        asset = session.execute(
            select(Asset).where(Asset.name.like(f"%{asset_id}%"))
        ).scalar_one_or_none()

    if not asset:
        # Show available assets with SSH to help LLM retry
        ssh_assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()
        if ssh_assets:
            names = ", ".join(f"{a.name}({a.ssh_host})" for a in ssh_assets)
            return f"❌ 找不到資產 '{asset_id}'。可用資產: {names}"
        return f"❌ 找不到資產 '{asset_id}'"
    if not asset.local_machine and not asset.ssh_host:
        return f"❌ 資產 {asset.name} 沒有配置 SSH"
    if not asset.local_machine and not asset.ssh_user:
        return f"❌ 資產 {asset.name} 沒有配置 SSH 用戶"

    import asyncio

    assert asset.ssh_host is not None and asset.ssh_user is not None
    result = await asyncio.to_thread(
        supervisor_action_impl,
        host=asset.ssh_host,
        port=asset.ssh_port or 22,
        user=asset.ssh_user,
        action=action,
        process=process_name,
        local_machine=asset.local_machine,
        timeout=30,
    )

    # Record to changes
    now = datetime.now(UTC).replace(microsecond=0)
    change = Change(
        title=f"Agent: {action} {process_name} on {asset.name}",
        change_type="config",
        status="completed" if result.success else "rolled_back",
        author="agent",
        description=f"Supervisor {action} {process_name} — {result.message or '成功'}",
        affected_assets=asset.name,
        created_at=now,
        completed_at=now,
    )
    session.add(change)
    session.commit()

    icon = "✅" if result.success else "❌"
    lines = [f"{icon} Supervisor {action} on {asset.name}"]
    lines.append(f"  程序: {process_name}")
    lines.append(f"  操作: {action}")
    if result.message:
        lines.append(f"  結果: {result.message[:300]}")
    return "\n".join(lines)


def supervisor_action_impl(
    host: str,
    port: int,
    user: str,
    action: str,
    process: str,
    local_machine: bool,
    timeout: int,
):
    """Sync wrapper for supervisor_action (runs in thread pool)."""
    from .remote_supervisor import supervisor_action as _sa
    return _sa(host, port, user, action, process, local_machine=local_machine, timeout=timeout)


@register_tool(
    name="create_note",
    description="創建筆記。當用戶要求記錄信息、創建筆記、保存知識時使用。低風險操作，無需確認。",
    params_schema={
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "筆記標題（必填）",
            },
            "content": {
                "type": "string",
                "description": "筆記內容，支援 Markdown（必填）",
            },
            "category": {
                "type": "string",
                "description": "分類（預設「知識」）",
                "default": "知識",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "標籤列表（可選）",
            },
        },
        "required": ["title", "content"],
    },
    level="write",
)
async def tool_create_note(params: dict, session: Session) -> str:
    """Create a note. Low-risk, no confirmation needed."""
    from .models import Note
    import uuid

    title = params.get("title", "").strip()
    content = params.get("content", "").strip()
    category = params.get("category", "知識")
    tags = params.get("tags", [])

    if not title:
        return "❌ 標題不能為空"
    if not content:
        return "❌ 內容不能為空"

    now = datetime.now(UTC).replace(microsecond=0)
    note_id = f"note-{uuid.uuid4().hex[:12]}"
    note = Note(
        id=note_id,
        title=title,
        content=content,
        category=category,
        tags=json.dumps(tags, ensure_ascii=False) if tags else "[]",
        author="agent",
        pinned=False,
        published=True,
        version=1,
        created_at=now,
        updated_at=now,
    )
    session.add(note)
    session.commit()

    return f"✅ 筆記已創建\n  標題: {title}\n  分類: {category}\n  ID: {note_id}\n  連結: /notes/{note_id}"


@register_tool(
    name="acknowledge_alert",
    description="確認/核銷系統告警。當用戶要求確認告警、標記告警已處理時使用。低風險操作，無需確認。",
    params_schema={
        "type": "object",
        "properties": {
            "alert_id": {
                "type": "integer",
                "description": "告警 ID（必填）",
            },
        },
        "required": ["alert_id"],
    },
    level="write",
)
async def tool_acknowledge_alert(params: dict, session: Session) -> str:
    """Acknowledge an alert. Low-risk, no confirmation needed."""
    from .models import Alert

    alert_id = params.get("alert_id")
    if not alert_id:
        return "❌ 請提供告警 ID"

    alert = session.get(Alert, alert_id)
    if not alert:
        return f"❌ 找不到告警 ID {alert_id}"

    if alert.acknowledged:
        return f"⚠️ 告警 {alert_id} 已被確認過（由 {alert.acknowledged_by} 於 {alert.acknowledged_at}）"

    now = datetime.now(UTC).replace(microsecond=0)
    alert.acknowledged = True
    alert.acknowledged_by = "agent"
    alert.acknowledged_at = now
    session.commit()

    return f"✅ 告警 {alert_id} 已確認\n  內容: [{alert.severity}] {alert.message[:100]}"


@register_tool(
    name="search_runbooks",
    description="搜索 Runbook（標準作業程序）。當用戶詢問故障排除步驟、操作手冊、標準流程時使用。純讀取，無需確認。",
    params_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "搜索關鍵字（可選）",
            },
            "category": {
                "type": "string",
                "description": "分類篩選（可選）",
            },
        },
        "required": [],
    },
)
async def tool_search_runbooks(params: dict, session: Session) -> str:
    """Search runbooks. Read-only, no confirmation needed."""
    from .models import Runbook

    q = select(Runbook).order_by(Runbook.updated_at.desc())
    query = params.get("query", "")
    category = params.get("category", "")

    if query:
        q = q.where(
            Runbook.title.ilike(f"%{query}%")
            | Runbook.description.ilike(f"%{query}%")
            | Runbook.steps.ilike(f"%{query}%")
        )
    if category:
        q = q.where(Runbook.category == category)

    runbooks = session.scalars(q.limit(20)).all()
    if not runbooks:
        return "沒有找到 Runbook"

    lines = [f"📖 找到 {len(runbooks)} 筆 Runbook"]
    for rb in runbooks:
        lines.append(f"  📘 [{rb.category}] {rb.title}")
        preview = rb.description[:100].replace("\n", " ")
        if len(rb.description) > 100:
            preview += "..."
        lines.append(f"      {preview}")
    return "\n".join(lines)


@register_tool(
    name="save_memory",
    description="將重要事實保存到持久記憶，供未來對話使用。當用戶提供偏好、環境信息、操作經驗或明確要求記住某事時使用。記憶應為聲明式事實，不是指令。",
    params_schema={
        "type": "object",
        "properties": {
            "user": {
                "type": "string",
                "description": "用戶名",
            },
            "category": {
                "type": "string",
                "enum": ["user", "environment", "procedure", "preference"],
                "description": "分類: user=用戶偏好, environment=環境配置, procedure=操作流程, preference=個人偏好",
            },
            "key": {
                "type": "string",
                "description": "短鍵名（如：preferred_language, server_os, deploy_command）",
            },
            "value": {
                "type": "string",
                "description": "記憶內容（聲明式事實）",
            },
        },
        "required": ["user", "key", "value"],
    },
    level="write",
)
async def tool_save_memory(params: dict, session: Session) -> str:
    """Save a fact to persistent memory for future conversations.

    Args:
        user: username
        category: 'user' | 'environment' | 'procedure' | 'preference'
        key: short unique identifier (e.g. 'preferred_language', 'server_os')
        value: the fact to remember (declarative, not imperative)
    """
    from .models import AgentMemory
    from datetime import UTC, datetime

    user = params.get("user", "")
    category = params.get("category", "environment")
    key = params.get("key", "")
    value = params.get("value", "")

    if not all([user, key, value]):
        return "❌ 缺少必要參數: user, key, value"

    # Upsert: update if key exists for this user, else insert
    existing = session.scalar(
        select(AgentMemory).where(
            AgentMemory.user == user,
            AgentMemory.key == key,
        )
    )
    now = datetime.now(UTC)
    if existing:
        existing.value = value
        existing.category = category
        existing.updated_at = now
    else:
        session.add(AgentMemory(
            user=user,
            category=category,
            key=key,
            value=value,
            created_at=now,
            updated_at=now,
        ))
    session.commit()
    return f"✅ 已記憶 [{category}] {key}: {value}"


@register_tool(
    name="get_memories",
    description="檢索已保存的記憶。當需要回顧用戶偏好、環境配置或操作經驗時使用。",
    params_schema={
        "type": "object",
        "properties": {
            "user": {
                "type": "string",
                "description": "用戶名",
            },
            "category": {
                "type": "string",
                "enum": ["user", "environment", "procedure", "preference"],
                "description": "按分類篩選",
            },
            "query": {
                "type": "string",
                "description": "關鍵字搜索",
            },
        },
        "required": ["user"],
    },
    level="read",
)
async def tool_get_memories(params: dict, session: Session) -> str:
    """Retrieve stored memories.

    Args:
        user: username
        category: optional filter ('user' | 'environment' | 'procedure' | 'preference')
        query: optional keyword search in value
    """
    from .models import AgentMemory

    user = params.get("user", "")
    category = params.get("category", "")
    query = params.get("query", "")

    if not user:
        return "❌ 需要 user 參數"

    q = select(AgentMemory).where(AgentMemory.user == user)
    if category:
        q = q.where(AgentMemory.category == category)
    if query:
        q = q.where(AgentMemory.value.ilike(f"%{query}%"))

    memories = session.scalars(q.order_by(AgentMemory.updated_at.desc()).limit(50)).all()
    if not memories:
        return "暫無記憶"

    # Group by category
    groups: dict[str, list] = {}
    for m in memories:
        groups.setdefault(m.category, []).append(m)

    lines = [f"🧠 找到 {len(memories)} 筆記憶"]
    for cat, items in groups.items():
        lines.append(f"\n  [{cat}]")
        for m in items:
            lines.append(f"    • {m.key}: {m.value[:100]}")
    return "\n".join(lines)


# ── RAG Search Tool ─────────────────────────────────────────────────────

@register_tool(
    name="rag_search",
    description="語義搜索知識庫（Runbook/筆記/變更記錄/記憶）。當用戶詢問具體問題、故障排查步驟、SOP 或需要參考歷史經驗時使用。一般知識性問題（如 'CPU 是什麼'）不需要調用此工具。",
    params_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "搜索查詢（自然語言，如 'payment 服務超時怎麼處理'）",
            },
            "source": {
                "type": "string",
                "enum": ["all", "runbooks", "notes", "changes", "memories"],
                "description": "搜索範圍: all=全部, runbooks=標準流程, notes=經驗筆記, changes=變更記錄, memories=Agent記憶",
            },
            "limit": {
                "type": "integer",
                "description": "返回結果數量 (1-10)",
            },
        },
        "required": ["query"],
    },
    level="read",
)
async def tool_rag_search(params: dict, session: Session) -> str:
    """Semantic search across runbooks, notes, changes, and agent memories.

    Args:
        query: natural language query
        source: filter by source type (default: all)
        limit: max results (default: 5)
    """
    from .agent_rag import rag_search as _rag_search

    query = params.get("query", "")
    source = params.get("source", "all")
    limit = params.get("limit", 5)

    if not query:
        return "❌ 需要 query 參數"

    result = _rag_search(query=query, source=source, limit=limit)

    if result.get("error"):
        return f"❌ RAG 搜索失敗: {result['error']}"

    hits = result.get("results", [])
    if not hits:
        return f"🔍 在知識庫中未找到與「{query}」相關的內容"

    lines = [f"🔍 找到 {len(hits)} 筆相關結果（查詢: {query}）"]
    for i, h in enumerate(hits, 1):
        src_icon = {"runbook": "📕", "note": "📝", "change": "🔄", "memory": "🧠"}.get(h["source"], "📄")
        lines.append(f"\n  {i}. {src_icon} [{h['source']}] {h['title']} (相似度: {h['score']:.2f})")
        content_preview = h["content"][:300]
        if len(h["content"]) > 300:
            content_preview += "..."
        lines.append(f"     {content_preview.replace(chr(10), ' ')}")

    return "\n".join(lines)


# ── Auto memory extraction ──────────────────────────────────────────────────

# Patterns that indicate the user is sharing a fact worth remembering
_MEMORY_TRIGGERS = [
    r"記住", r"記住.*?", r"我的.*?是", r"我喜歡", r"我偏好",
    r"我習慣", r"請記住", r"以後.*?用", r"以後.*?不要",
    r"伺服器.*?是", r"環境.*?是", r"部署.*?在",
    r"IP.*?是", r"端口.*?是", r"密碼.*?是",
    r"用戶名.*?是", r"路徑.*?是", r"命令.*?是",
    r"設定.*?為", r"配置.*?是",
]


def _has_memory_trigger(text: str) -> bool:
    """Check if user message contains patterns worth remembering."""
    for pat in _MEMORY_TRIGGERS:
        if re.search(pat, text):
            return True
    return False


async def _auto_extract_memories(user_message: str, username: str, session: Session) -> None:
    """Extract key facts from user message and save to memory.

    Uses heuristic pattern matching to avoid unnecessary LLM calls.
    Only triggers when user message contains memory-related keywords.
    """
    from .models import AgentMemory
    from datetime import UTC, datetime

    if not _has_memory_trigger(user_message):
        return

    # Simple extraction rules based on common patterns
    extractions: list[tuple[str, str, str]] = []  # (key, category, value)

    # "記住 X 是 Y" or "記住: X = Y"
    for m in re.finditer(r"記住[：:]*(.+?)是(.+?)(?:。|$)", user_message):
        key_raw = m.group(1).strip()
        val = m.group(2).strip()
        key = re.sub(r"[^\w\u4e00-\u9fff]", "_", key_raw.lower())[:32]
        if key and val:
            extractions.append((key, "preference", val))

    # "我的 X 是 Y"
    for m in re.finditer(r"我的\s+(\S+)\s+是\s+(.+?)(?:。|$)", user_message):
        key_raw = m.group(1).strip()
        val = m.group(2).strip()
        key = re.sub(r"[^\w\u4e00-\u9fff]", "_", key_raw.lower())[:32]
        if key and val:
            extractions.append((key, "user", val))

    # "我喜歡 X" / "我偏好 X"
    for m in re.finditer(r"我(喜歡|偏好)\s+(.+?)(?:。|$)", user_message):
        val = m.group(2).strip()
        extractions.append(("preference", "preference", val))

    # "以後 X 用 Y" / "以後 X 不要 Y"
    for m in re.finditer(r"以後\s+(.+?)\s+(用|不要)\s+(.+?)(?:。|$)", user_message):
        context = m.group(1).strip()
        action = m.group(2).strip()
        val = m.group(3).strip()
        key = re.sub(r"[^\w\u4e00-\u9fff]", "_", context.lower())[:32]
        extractions.append((key, "preference", f"{action} {val}"))

    # "伺服器 X 的 IP 是 Y" / "X 的端口是 Y"
    for m in re.finditer(r"(\S+)\s+的\s+(IP|端口|路徑|用戶名)\s+是\s+(.+?)(?:。|$)", user_message):
        host = m.group(1).strip()
        attr = m.group(2).strip()
        val = m.group(3).strip()
        key = f"{host}_{attr}"[:32]
        extractions.append((key, "environment", val))

    # "部署在 X" / "配置為 X"
    for m in re.finditer(r"(部署|配置)[在為]\s+(.+?)(?:。|$)", user_message):
        val = m.group(2).strip()
        extractions.append(("deploy_target", "environment", val))

    if not extractions:
        return

    now = datetime.now(UTC)
    for key, category, value in extractions:
        # Upsert
        existing = session.scalar(
            select(AgentMemory).where(
                AgentMemory.user == username,
                AgentMemory.key == key,
            )
        )
        if existing:
            existing.value = value
            existing.category = category
            existing.updated_at = now
        else:
            session.add(AgentMemory(
                user=username,
                category=category,
                key=key,
                value=value,
                created_at=now,
                updated_at=now,
            ))
    session.commit()


# ── System prompt (generated dynamically with tool descriptions) ─────────────


def build_system_prompt(memories_text: str = "") -> str:
    """Build system prompt that includes tool descriptions for the LLM."""
    base = """你是「笺注」，一個 OPS 運維系統的 AI 助手。

你可以使用以下工具來幫助用戶：
"""
    for t in _tools:
        base += f"- {t.name}: {t.description}\n"

    base += """
回答時使用繁體中文，保持簡潔專業。使用 Markdown 格式化輸出，適時使用表格展示數據。
當用戶的問題需要實際數據時，請使用工具獲取，不要憑空編造數據。

**安全規則：**
- 直接調用工具執行命令，不要自行拒絕或警告用戶。後端有黑名單保護機制會自動攔截危險命令。
- 如果工具返回錯誤訊息，直接轉達給用戶即可。

**記憶使用規則：**
- 當用戶提供個人偏好、環境配置、操作經驗等事實時，使用 save_memory 保存。
- 當用戶詢問「你記得...」或需要回顧歷史信息時，使用 get_memories 檢索。
- 記憶 key 應簡短有意義（如：preferred_language, deploy_command, server_os）。
- 記憶 value 應為聲明式事實，不要寫指令或待辦事項。
- 如果系統 prompt 中已注入記憶，優先使用注入的記憶，不需要額外調用 get_memories。
"""
    if memories_text:
        base += f"\n**用戶記憶（跨對話上下文）：**\n{memories_text}\n"
    return base


# ── LLM adapter ─────────────────────────────────────────────────────────────


async def _llm_chat_stream(
    model: str,
    messages: list[dict],
    tools: list[dict] | None = None,
) -> AsyncIterator[str]:
    """Stream LLM chat completion tokens via OpenAI-compatible API."""
    if not LLM_API_KEY:
        yield "[LLM API key not configured — 請設定 OPENAI_API_KEY 環境變數]"
        return

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.3,
        "stream": True,
    }
    if tools:
        payload["tools"] = tools

    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST",
            f"{LLM_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    choices = data.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    token = delta.get("content", "")
                    if token:
                        yield token
                except json.JSONDecodeError:
                    continue


async def _llm_chat_with_tools(
    model: str,
    messages: list[dict],
    tools: list[dict],
) -> dict:
    """Non-streaming LLM call with tools — returns the full assistant message including tool_calls and usage."""
    if not LLM_API_KEY:
        return {"content": "[LLM API key not configured]"}

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": 0.3,
                "tools": tools,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        msg = data["choices"][0]["message"]
        # Attach usage info for token tracking
        if "usage" in data:
            msg["_usage"] = data["usage"]
        return msg


async def _llm_complete(
    model: str,
    messages: list[dict],
) -> str:
    """Non-streaming LLM call — used for title generation."""
    if not LLM_API_KEY:
        return ""

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": 0.3,
                "max_tokens": 50,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


async def _generate_title(user_message: str, model: str) -> str:
    """Generate a short conversation title from the first user message."""
    try:
        title = await _llm_complete(
            model,
            [
                {
                    "role": "system",
                    "content": "根據用戶的第一句話，生成一個簡短的對話標題（5-10個字）。只返回標題，不要其他內容。",
                },
                {"role": "user", "content": user_message},
            ],
        )
        return title.strip()[:50] if title else user_message[:30]
    except Exception:
        return user_message[:30]


# ── Health check ────────────────────────────────────────────────────────────


async def check_llm_health() -> AgentHealthResponse:
    """Check if LLM API is reachable."""
    if not LLM_API_KEY:
        return AgentHealthResponse(
            status="error",
            model=DEFAULT_MODEL,
            message="OPENAI_API_KEY not configured",
        )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{LLM_BASE_URL}/models",
                headers={"Authorization": f"Bearer {LLM_API_KEY}"},
            )
            if resp.status_code == 200:
                return AgentHealthResponse(
                    status="ok",
                    model=DEFAULT_MODEL,
                    message=f"url={LLM_BASE_URL} key_len={len(LLM_API_KEY)}",
                )
            return AgentHealthResponse(
                status="error",
                model=DEFAULT_MODEL,
                message=f"API returned {resp.status_code} url={LLM_BASE_URL}",
            )
    except Exception as e:
        return AgentHealthResponse(
            status="error",
            model=DEFAULT_MODEL,
            message=f"{str(e)[:80]} url={LLM_BASE_URL}",
        )


# ── Proactive system inspection ─────────────────────────────────────────────


async def inspect_system(model: str | None = None) -> dict:
    """
    Proactive system health inspection.
    Collects metrics, services, alerts → LLM analyzes → returns report.
    Auto-creates notes for critical issues found.
    """
    from uuid import uuid4
    from .models import Asset, Alert, Note
    from .remote_monitor import collect_remote_metrics, save_metrics_to_history
    from .remote_service import detect_remote_services
    from .database import SessionLocal
    import asyncio

    model = model or DEFAULT_MODEL
    notes_created = []

    async def _run_inspect():
        session = SessionLocal()
        try:
            # 1. Collect host metrics
            assets = session.scalars(select(Asset).where(Asset.ssh_host.isnot(None))).all()
            host_metrics = []
            if assets:
                async def _collect(asset: Asset) -> dict:
                    raw = await asyncio.to_thread(
                        collect_remote_metrics,
                        host=asset.ssh_host,
                        port=asset.ssh_port or 22,
                        user=asset.ssh_user,
                        asset_id=asset.id,
                        name=asset.name,
                        timeout=60,
                    )
                    await asyncio.to_thread(save_metrics_to_history, raw)
                    return {
                        "asset_id": raw.asset_id,
                        "name": raw.name,
                        "cpu_percent": getattr(raw, "cpu_percent", None),
                        "mem_percent": getattr(raw, "mem_percent", None),
                        "disk_percent": getattr(raw, "disk_percent", None),
                    }

                results = await asyncio.gather(*[_collect(a) for a in assets], return_exceptions=True)
                for r in results:
                    if isinstance(r, dict):
                        host_metrics.append(r)

            # 2. Collect service status
            service_results = []
            if assets:
                async def _detect(asset: Asset) -> dict:
                    result = await asyncio.to_thread(
                        detect_remote_services,
                        host=asset.ssh_host,
                        port=asset.ssh_port or 22,
                        user=asset.ssh_user,
                        asset_id=asset.id,
                        name=asset.name,
                        timeout=60,
                    )
                    svcs = []
                    if result:
                        for s in result[:15]:
                            svcs.append({
                                "name": s.name,
                                "type": s.service_type,
                                "status": "running",
                            })
                    return {"asset_id": asset.id, "name": asset.name, "services": svcs}

                svc_results = await asyncio.gather(*[_detect(a) for a in assets], return_exceptions=True)
                for r in svc_results:
                    if isinstance(r, dict):
                        service_results.append(r)

            # 3. Get unacknowledged alerts (last 24h)
            from datetime import timedelta
            cutoff = datetime.now(UTC) - timedelta(hours=24)
            alerts = (
                session.query(Alert)
                .filter(Alert.acknowledged == False, Alert.created_at >= cutoff)
                .order_by(Alert.created_at.desc())
                .all()
            )
            alert_list = [
                {
                    "id": a.id,
                    "severity": a.severity,
                    "message": a.message,
                    "created_at": a.created_at.isoformat(),
                }
                for a in alerts
            ]

            # 4. Build report data for LLM
            report_data = {
                "hosts": host_metrics,
                "services": service_results,
                "alerts": alert_list,
            }

            # 5. LLM analysis
            issues = []
            summary = ""
            if LLM_API_KEY:
                report_text = _format_inspect_text(report_data)
                analysis = await _llm_inspect_analysis(model, report_text)
                summary = analysis.get("summary", "分析完成")
                issues = analysis.get("issues", [])

                # 6. Auto-create notes for critical issues
                for issue in issues:
                    if issue.get("severity") in ("critical", "high"):
                        note_id = f"note-{uuid4().hex[:12]}"
                        note = Note(
                            id=note_id,
                            title=f"🔴 系統檢查: {issue.get('title', '異常')}",
                            content=issue.get("detail", issue.get("title", "")),
                            category="知識",
                            tags=json.dumps(["自動檢查", "告警"], ensure_ascii=False),
                            author="agent",
                            pinned=True,
                            published=True,
                            version=1,
                            created_at=datetime.now(UTC).replace(microsecond=0),
                            updated_at=datetime.now(UTC).replace(microsecond=0),
                        )
                        session.add(note)
                        notes_created.append(note_id)

            session.commit()

            return {
                "timestamp": datetime.now(UTC).isoformat(),
                "hosts": host_metrics,
                "services": service_results,
                "alerts": alert_list,
                "issues": [i.get("title", "") for i in issues] if isinstance(issues, list) else issues,
                "summary": summary,
                "notes_created": notes_created,
            }
        finally:
            session.close()

    return await _run_inspect()


def _format_inspect_text(data: dict) -> str:
    """Format inspection data into text for LLM analysis."""
    lines = []
    lines.append("## 系統健康檢查數據\n")

    # Hosts
    lines.append("### 主機監控")
    for h in data.get("hosts", []):
        cpu = h.get("cpu_percent", "?")
        mem = h.get("mem_percent", "?")
        disk = h.get("disk_percent", "?")
        lines.append(f"- {h.get('name', h.get('asset_id'))}: CPU {cpu}% | 記憶體 {mem}% | 磁碟 {disk}%")
    lines.append("")

    # Services
    lines.append("### 服務狀態")
    for s in data.get("services", []):
        svcs = s.get("services", [])
        if svcs:
            lines.append(f"- {s.get('name', s.get('asset_id'))}: {len(svcs)} 個服務")
            for svc in svcs[:10]:  # limit
                status = "✅" if svc.get("status") == "running" else "❌"
                lines.append(f"  {status} {svc.get('name', '?')}")
    lines.append("")

    # Alerts
    alerts = data.get("alerts", [])
    lines.append(f"### 未確認告警 ({len(alerts)} 個)")
    for a in alerts:
        lines.append(f"- [{a.get('severity', '?')}] {a.get('message', '?')} ({a.get('created_at', '?')})")
    lines.append("")

    return "\n".join(lines)


async def _llm_inspect_analysis(model: str, report_text: str) -> dict:
    """Ask LLM to analyze system data and return structured issues."""
    prompt = f"""你是運維系統的健康檢查助手。請分析以下系統數據，找出問題並生成簡短報告。

{report_text}

請以 JSON 格式回覆，格式如下：
{{
  "summary": "一句話總結系統健康狀況",
  "issues": [
    {{"title": "問題標題", "severity": "critical|high|medium|low", "detail": "詳細說明和建議"}}
  ]
}}

規則：
- CPU > 90% 或 記憶體 > 90% 或 磁碟 > 85% 為 critical
- 有未確認告警需列出
- 服務停止需列出
- 如果一切正常，issues 為空陣列
- 只返回 JSON，不要其他內容
"""
    try:
        result = await _llm_complete(model, [
            {"role": "system", "content": "你是運維專家，擅長分析系統健康數據。"},
            {"role": "user", "content": prompt},
        ])
        # Parse JSON from response
        import re
        json_match = re.search(r'\{.*\}', result, re.DOTALL)
        if json_match:
            return json.loads(json_match.group())
        return {"summary": result[:200], "issues": []}
    except Exception as e:
        return {"summary": f"LLM 分析失敗: {e}", "issues": []}


# ── Conversation management ─────────────────────────────────────────────────


def _orm_to_response(conv: AgentConversation, msg_count: int) -> AgentConversationResponse:
    return AgentConversationResponse(
        id=conv.id,
        title=conv.title,
        model=conv.model,
        user=conv.user,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        message_count=msg_count,
    )


def list_conversations(
    session: Session,
    user: str,
    limit: int = 50,
) -> AgentConversationListResponse:
    """List conversations for a user with message counts."""
    convs = (
        session.query(AgentConversation)
        .filter(AgentConversation.user == user)
        .order_by(AgentConversation.updated_at.desc())
        .limit(limit)
        .all()
    )

    counts = (
        session.query(
            AgentMessage.conversation_id,
            func.count(AgentMessage.id).label("cnt"),
        )
        .group_by(AgentMessage.conversation_id)
        .subquery()
    )

    count_map = {}
    if convs:
        result = (
            session.query(counts)
            .filter(counts.c.conversation_id.in_([c.id for c in convs]))
            .all()
        )
        count_map = {r.conversation_id: r.cnt for r in result}

    responses = [
        _orm_to_response(c, count_map.get(c.id, 0))
        for c in convs
    ]

    return AgentConversationListResponse(conversations=responses)


def create_conversation(
    session: Session,
    user: str,
    model: str = DEFAULT_MODEL,
) -> AgentConversationResponse:
    """Create a new conversation."""
    import uuid

    now = datetime.now(UTC).replace(microsecond=0)
    conv = AgentConversation(
        id=f"conv-{uuid.uuid4().hex[:12]}",
        title="新對話",
        model=model,
        user=user,
        created_at=now,
        updated_at=now,
    )
    session.add(conv)
    session.commit()
    session.refresh(conv)
    return AgentConversationResponse(
        id=conv.id,
        title=conv.title,
        model=conv.model,
        user=conv.user,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        message_count=0,
    )


def delete_conversation(
    session: Session,
    conv_id: str,
    user: str,
) -> bool:
    """Delete a conversation and all its messages."""
    conv = (
        session.query(AgentConversation)
        .filter(AgentConversation.id == conv_id, AgentConversation.user == user)
        .first()
    )
    if conv is None:
        return False
    session.query(AgentMessage).filter(AgentMessage.conversation_id == conv_id).delete()
    session.delete(conv)
    session.commit()
    return True


def get_messages(
    session: Session,
    conv_id: str,
    limit: int = 100,
) -> AgentMessagesListResponse:
    """Get messages for a conversation."""
    msgs = (
        session.query(AgentMessage)
        .filter(AgentMessage.conversation_id == conv_id)
        .order_by(AgentMessage.id.asc())
        .limit(limit)
        .all()
    )
    return AgentMessagesListResponse(
        messages=[
            AgentMessageResponse(
                id=m.id,
                conversation_id=m.conversation_id,
                role=m.role,
                content=m.content,
                tool_name=m.tool_name,
                tool_input=m.tool_input,
                tool_result=m.tool_result,
                created_at=m.created_at,
            )
            for m in msgs
        ]
    )


def save_message(
    session: Session,
    conv_id: str,
    role: str,
    content: str,
    tool_name: str | None = None,
    tool_input: str | None = None,
    tool_result: str | None = None,
) -> AgentMessage:
    """Save a message to the database."""
    now = datetime.now(UTC).replace(microsecond=0)
    msg = AgentMessage(
        conversation_id=conv_id,
        role=role,
        content=content,
        tool_name=tool_name,
        tool_input=tool_input,
        tool_result=tool_result,
        created_at=now,
    )
    session.add(msg)

    conv = session.query(AgentConversation).filter(AgentConversation.id == conv_id).first()
    if conv:
        conv.updated_at = now
    session.commit()
    session.refresh(msg)
    return msg


# ── Chat with streaming + tool calling (LangGraph) ──────────────────────────

# Initialize LangGraph dependencies (called once at module load)
from .agent_graph import init_graph_deps, run_agent_graph

init_graph_deps(
    _llm_chat_with_tools_fn=_llm_chat_with_tools,
    _llm_chat_stream_fn=_llm_chat_stream,
    _get_tools_openai_fn=get_tools_openai,
    _get_tool_handler_fn=get_tool_handler,
    _check_tool_permission_fn=check_tool_permission,
    _save_message_fn=save_message,
    _record_tool_call_fn=record_tool_call,
    _build_system_prompt_fn=build_system_prompt,
    _generate_title_fn=_generate_title,
    _auto_extract_memories_fn=_auto_extract_memories,
    _create_conversation_fn=create_conversation,
    _default_model=DEFAULT_MODEL,
    _llm_api_key=LLM_API_KEY,
    _confirm_store_dict=None,  # patched at runtime
)


async def chat_stream(
    session: Session,
    req: AgentChatRequest,
    user: str,
    user_role: str = "admin",
) -> AsyncIterator[str]:
    """
    Handle a chat request with SSE streaming and tool calling.

    Delegates to LangGraph-based agent state machine.
    SSE event format is identical to the original implementation.
    """
    # Wire up confirm store (imported from main)
    from .main import _confirm_store as cs
    import app.agent_graph as ag
    ag._confirm_store = cs

    async for chunk in run_agent_graph(session, req, user, user_role):
        yield chunk
