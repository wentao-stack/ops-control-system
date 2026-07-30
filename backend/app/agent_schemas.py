from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


# ── Conversation schemas ─────────────────────────────────────────────────────

class AgentConversationResponse(BaseModel):
    id: str
    title: str
    model: str
    user: str
    created_at: datetime
    updated_at: datetime
    message_count: int = 0

    class Config:
        from_attributes = True


class AgentConversationListResponse(BaseModel):
    conversations: list[AgentConversationResponse]


class AgentConversationCreate(BaseModel):
    model: str = "gpt-4o-mini"


# ── Message schemas ──────────────────────────────────────────────────────────

class AgentMessageResponse(BaseModel):
    id: int
    conversation_id: str
    role: str
    content: str
    tool_name: str | None
    tool_input: str | None
    tool_result: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class AgentMessagesListResponse(BaseModel):
    messages: list[AgentMessageResponse]


# ── Chat request ─────────────────────────────────────────────────────────────

class AgentChatRequest(BaseModel):
    conversation_id: str | None = None
    message: str = Field(min_length=1)
    model: str = "gpt-4o-mini"


# ── Health ───────────────────────────────────────────────────────────────────

class AgentHealthResponse(BaseModel):
    status: str  # "ok" | "error"
    model: str
    message: str = ""
