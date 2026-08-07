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
    # Leave the model unset so the service can use AGENT_DEFAULT_MODEL.
    # A hard-coded schema default overrides the configured local model even
    # when clients (such as the web UI) do not send a model field.
    model: str | None = None


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
    model: str | None = None


# ── Health ───────────────────────────────────────────────────────────────────

class AgentHealthResponse(BaseModel):
    status: str  # "ok" | "error"
    model: str
    message: str = ""


# ── Inspect (proactive monitoring) schemas ───────────────────────────────────

class AgentInspectRequest(BaseModel):
    """Request for proactive system inspection."""
    model: str | None = None


class AgentInspectReport(BaseModel):
    """Health inspection report returned by /inspect."""
    timestamp: str
    hosts: list[dict]  # per-host metrics summary
    services: list[dict]  # per-host service summary
    alerts: list[dict]  # recent unacknowledged alerts
    issues: list[str]  # LLM-analyzed issues
    summary: str  # LLM-generated summary
    notes_created: list[str]  # note IDs auto-created for issues
