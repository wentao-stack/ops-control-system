from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import AsyncIterator

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

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
LLM_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
DEFAULT_MODEL = os.getenv("AGENT_DEFAULT_MODEL", "gpt-4o-mini")

# ── System prompt ───────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
你是「笺注」，一個 OPS 運維系統的 AI 助手。

你可以幫助用戶：
- 查看主機監控數據（CPU、記憶體、磁碟、GPU）
- 查看服務狀態和告警
- 管理筆記和資產
- 執行運維任務

回答時使用繁體中文，保持簡潔專業。使用 Markdown 格式化輸出，適時使用表格展示數據。
"""


# ── LLM adapter ─────────────────────────────────────────────────────────────


async def _llm_chat_stream(
    model: str,
    messages: list[dict],
) -> AsyncIterator[str]:
    """Stream LLM chat completion tokens via OpenAI-compatible API."""
    if not LLM_API_KEY:
        yield "[LLM API key not configured — 請設定 OPENAI_API_KEY 環境變數]"
        return

    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST",
            f"{LLM_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": 0.3,
                "stream": True,
            },
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
                return AgentHealthResponse(status="ok", model=DEFAULT_MODEL)
            return AgentHealthResponse(
                status="error",
                model=DEFAULT_MODEL,
                message=f"API returned {resp.status_code}",
            )
    except Exception as e:
        return AgentHealthResponse(
            status="error",
            model=DEFAULT_MODEL,
            message=str(e)[:120],
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
    # Get conversations
    convs = (
        session.query(AgentConversation)
        .filter(AgentConversation.user == user)
        .order_by(AgentConversation.updated_at.desc())
        .limit(limit)
        .all()
    )

    # Get message counts
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
    # Delete messages first (FK cascade in ORM, but explicit is safer for SQLite)
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

    # Update conversation timestamp
    conv = session.query(AgentConversation).filter(AgentConversation.id == conv_id).first()
    if conv:
        conv.updated_at = now
    session.commit()
    session.refresh(msg)
    return msg


# ── Chat with streaming ─────────────────────────────────────────────────────


async def chat_stream(
    session: Session,
    req: AgentChatRequest,
    user: str,
) -> AsyncIterator[str]:
    """
    Handle a chat request with SSE streaming.

    Yields SSE-formatted lines:
      data: {"event": "token", "token": "..."}
      data: {"event": "done"}
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

    # Build message history for LLM (last 20 messages to control context)
    history = (
        session.query(AgentMessage)
        .filter(AgentMessage.conversation_id == conv_id)
        .order_by(AgentMessage.id.asc())
        .limit(40)
        .all()
    )

    llm_messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history:
        if m.role == "tool":
            continue  # Skip tool messages for LLM context in Week 1
        llm_messages.append({"role": m.role, "content": m.content})

    # Stream LLM response
    full_response = ""
    try:
        async for token in _llm_chat_stream(model, llm_messages):
            full_response += token
            yield f'data: {json.dumps({"event": "token", "token": token})}\n\n'
    except Exception as e:
        error_msg = f"\n\n⚠ 請求失敗：{str(e)[:200]}"
        full_response += error_msg
        yield f'data: {json.dumps({"event": "token", "token": error_msg})}\n\n'

    # Save assistant message
    if full_response:
        save_message(session, conv_id, "assistant", full_response)

    # Generate title for new conversations
    if is_new and not full_response.startswith("⚠"):
        try:
            title = await _generate_title(req.message, model)
            conv_obj = session.query(AgentConversation).filter(AgentConversation.id == conv_id).first()
            if conv_obj and conv_obj.title == "新對話":
                conv_obj.title = title
                session.commit()
        except Exception:
            pass  # Title generation failure is non-critical

    # Done signal
    yield 'data: {"event": "done"}\n\n'
