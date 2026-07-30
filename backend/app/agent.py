from __future__ import annotations

import json
import os
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
DEFAULT_MODEL = os.getenv("AGENT_DEFAULT_MODEL", "qwen36-27b-mtp-102k")

# ── Tool Registry ───────────────────────────────────────────────────────────


class ToolDef:
    """A single tool definition with name, description, JSON schema params, and handler."""

    def __init__(self, name: str, description: str, params_schema: dict[str, Any], handler):
        self.name = name
        self.description = description
        self.params_schema = params_schema  # JSON Schema object for the tool
        self.handler = handler  # async callable(params: dict, session: Session) -> str

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


def register_tool(name: str, description: str, params_schema: dict[str, Any]):
    """Decorator to register a tool."""
    def wrapper(fn):
        _tools.append(ToolDef(name, description, params_schema, fn))
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
    from .remote_monitor import collect_remote_metrics
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
            timeout=60,
        )
        lines = [f"📊 {asset.name} ({asset.ssh_host})"]
        if result.services:
            for s in result.services[:15]:  # limit display
                lines.append(f"  ● {s.name} ({s.type}) — {s.description or '無描述'}")
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


# ── System prompt (generated dynamically with tool descriptions) ─────────────


def build_system_prompt() -> str:
    """Build system prompt that includes tool descriptions for the LLM."""
    base = """你是「笺注」，一個 OPS 運維系統的 AI 助手。

你可以使用以下工具來幫助用戶：
"""
    for t in _tools:
        base += f"- {t.name}: {t.description}\n"

    base += """
回答時使用繁體中文，保持簡潔專業。使用 Markdown 格式化輸出，適時使用表格展示數據。
當用戶的問題需要實際數據時，請使用工具獲取，不要憑空編造數據。
"""
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
    """Non-streaming LLM call with tools — returns the full assistant message including tool_calls."""
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
        return data["choices"][0]["message"]


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


# ── Chat with streaming + tool calling ──────────────────────────────────────


async def chat_stream(
    session: Session,
    req: AgentChatRequest,
    user: str,
) -> AsyncIterator[str]:
    """
    Handle a chat request with SSE streaming and tool calling.

    Flow:
    1. Stream LLM response (with tools)
    2. If LLM returns tool_calls → execute tools → append results → call LLM again
    3. Final LLM response is streamed to frontend
    Max iterations: 5 to prevent infinite loops.
    """
    conv_id = req.conversation_id
    model = req.model or DEFAULT_MODEL

    # Auto-create conversation if none provided
    is_new = False
    if not conv_id:
        new_conv = create_conversation(session, user, model)
        conv_id = new_conv.id
        is_new = True

    # Verify conversation exists and belongs to user
    conv = (
        session.query(AgentConversation)
        .filter(AgentConversation.id == conv_id, AgentConversation.user == user)
        .first()
    )
    if conv is None:
        yield f'data: {json.dumps({"event": "error", "message": "Conversation not found"})}\n\n'
        return

    # Save user message
    save_message(session, conv_id, "user", req.message)

    # Build message history for LLM
    history = (
        session.query(AgentMessage)
        .filter(AgentMessage.conversation_id == conv_id)
        .order_by(AgentMessage.id.asc())
        .limit(40)
        .all()
    )

    tools_openai = get_tools_openai()

    llm_messages: list[dict] = [{"role": "system", "content": build_system_prompt()}]
    for m in history:
        if m.role == "tool" and m.tool_name:
            # Reconstruct tool call + result pair for LLM context
            handler = get_tool_handler(m.tool_name)
            params = {}
            if m.tool_input:
                try:
                    params = json.loads(m.tool_input)
                except json.JSONDecodeError:
                    params = {}
            llm_messages.append({
                "role": "assistant",
                "tool_calls": [{
                    "id": f"call_{m.id}",
                    "type": "function",
                    "function": {
                        "name": m.tool_name,
                        "arguments": json.dumps(params),
                    },
                }],
            })
            llm_messages.append({
                "role": "tool",
                "tool_call_id": f"call_{m.id}",
                "content": m.tool_result or "",
            })
        elif m.role in ("user", "assistant"):
            llm_messages.append({"role": m.role, "content": m.content})

    # Tool calling loop (max 5 iterations)
    max_iterations = 5
    for iteration in range(max_iterations):
        # Call LLM with tools
        assistant_msg = await _llm_chat_with_tools(model, llm_messages, tools_openai)

        # Append assistant message to LLM context
        llm_messages.append(assistant_msg)

        # Check for tool calls
        tool_calls = assistant_msg.get("tool_calls", [])
        if not tool_calls:
            # No tool calls — stream the final response
            content = assistant_msg.get("content", "") or ""
            # Stream token by token for UX
            for i in range(0, len(content), 4):
                chunk = content[i:i+4]
                yield f'data: {json.dumps({"event": "token", "token": chunk})}\n\n'
            # Save final assistant message
            save_message(session, conv_id, "assistant", content)
            break

        # Execute tool calls
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            tool_args_str = func.get("arguments", "{}")

            # Parse arguments
            try:
                tool_args = json.loads(tool_args_str) if isinstance(tool_args_str, str) else tool_args_str
            except json.JSONDecodeError:
                tool_args = {}

            # Emit tool_use event to frontend
            yield f'data: {json.dumps({"event": "tool_use", "name": tool_name, "parameters": tool_args})}\n\n'

            # Execute the tool
            handler = get_tool_handler(tool_name)
            if handler:
                try:
                    result = await handler.handler(tool_args, session)
                except Exception as e:
                    result = f"工具執行錯誤: {str(e)[:200]}"
            else:
                result = f"未知工具: {tool_name}"

            # Emit tool_result event to frontend
            yield f'data: {json.dumps({"event": "tool_result", "name": tool_name, "result": result})}\n\n'

            # Save tool message to DB
            save_message(
                session, conv_id, "tool", "",
                tool_name=tool_name,
                tool_input=json.dumps(tool_args, ensure_ascii=False),
                tool_result=result,
            )

            # Append tool result to LLM context
            llm_messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", f"call_{iteration}"),
                "content": result,
            })

    else:
        # Safety: exceeded max iterations
        error_text = "\n\n⚠ 達到最大迭代次數，停止處理"
        yield f'data: {json.dumps({"event": "token", "token": error_text})}\n\n'
        save_message(session, conv_id, "assistant", "達到最大迭代次數，停止處理")

    # Generate title for new conversations
    if is_new:
        try:
            title = await _generate_title(req.message, model)
            conv_obj = session.query(AgentConversation).filter(AgentConversation.id == conv_id).first()
            if conv_obj and conv_obj.title == "新對話":
                conv_obj.title = title
                session.commit()
        except Exception:
            pass

    # Done signal
    yield 'data: {"event": "done"}\n\n'
