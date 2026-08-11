from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


# ── Conversation schemas ─────────────────────────────────────────────────────

class AgentConversationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    model: str
    user: str
    created_at: datetime
    updated_at: datetime
    message_count: int = 0

class AgentConversationListResponse(BaseModel):
    conversations: list[AgentConversationResponse]
    total: int = 0
    offset: int = 0
    limit: int = 50


class AgentConversationCreate(BaseModel):
    # Leave the model unset so the service can use AGENT_DEFAULT_MODEL.
    # A hard-coded schema default overrides the configured local model even
    # when clients (such as the web UI) do not send a model field.
    model: str | None = Field(default=None, max_length=128)


# ── Message schemas ──────────────────────────────────────────────────────────

class AgentMessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    conversation_id: str
    role: str
    content: str
    tool_name: str | None
    tool_input: str | None
    tool_result: str | None
    created_at: datetime

class AgentMessagesListResponse(BaseModel):
    messages: list[AgentMessageResponse]
    total: int = 0
    has_more: bool = False


# ── Chat request ─────────────────────────────────────────────────────────────

class AgentChatRequest(BaseModel):
    conversation_id: str | None = Field(default=None, max_length=64)
    message: str = Field(min_length=1, max_length=10_000)
    model: str | None = Field(default=None, max_length=128)

    @field_validator("message")
    @classmethod
    def message_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("message must not be blank")
        return value


class AgentConfirmRequest(BaseModel):
    confirm_id: str = Field(min_length=1, max_length=64)
    approved: bool = True


class AgentMemoryUpsert(BaseModel):
    key: str = Field(min_length=1, max_length=128)
    value: str = Field(min_length=1, max_length=10_000)
    category: Literal["user", "environment", "procedure", "preference"] = "environment"

    @field_validator("key", "value")
    @classmethod
    def strip_non_empty_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value


# ── Health ───────────────────────────────────────────────────────────────────

class AgentHealthResponse(BaseModel):
    status: str  # "ok" | "error"
    model: str
    message: str = ""


# ── Inspect (proactive monitoring) schemas ───────────────────────────────────

class AgentInspectRequest(BaseModel):
    """Request for proactive system inspection."""
    model: str | None = Field(default=None, max_length=128)
    create_notes: bool = False


class AgentInspectReport(BaseModel):
    """Health inspection report returned by /inspect."""
    timestamp: str
    hosts: list[dict]  # per-host metrics summary
    services: list[dict]  # per-host service summary
    alerts: list[dict]  # recent unacknowledged alerts
    issues: list[str]  # LLM-analyzed issues
    summary: str  # LLM-generated summary
    notes_created: list[str]  # note IDs auto-created for issues
