from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.agent import get_messages
from app.agent_models import AgentConversation, AgentMessage
from app.agent_schemas import AgentConfirmRequest
from app.main import _confirm_store, agent_confirm, app


def test_agent_confirmation_requires_authentication():
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/agent/confirm",
            json={"confirm_id": "cf-missing", "approved": True},
        )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_confirmation_is_scoped_to_the_requesting_user():
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    _confirm_store["cf-owner"] = (future, {"approved": False, "user": "owner"})

    with pytest.raises(HTTPException) as exc:
        await agent_confirm(
            AgentConfirmRequest(confirm_id="cf-owner", approved=True),
            current_user=SimpleNamespace(username="other"),
        )

    assert exc.value.status_code == 403
    assert "cf-owner" in _confirm_store
    _confirm_store.pop("cf-owner", None)
    future.cancel()


@pytest.mark.asyncio
async def test_confirmation_resolves_the_matching_pending_request():
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    metadata = {"approved": False, "user": "owner"}
    _confirm_store["cf-owner"] = (future, metadata)

    response = await agent_confirm(
        AgentConfirmRequest(confirm_id="cf-owner", approved=True),
        current_user=SimpleNamespace(username="owner"),
    )

    assert response == {"status": "ok"}
    assert future.result() is True
    assert metadata["approved"] is True
    assert "cf-owner" not in _confirm_store


def test_message_history_returns_the_latest_window_in_chronological_order(session):
    now = datetime.now(UTC)
    conversation = AgentConversation(
        id="conv-long",
        title="long conversation",
        model="test-model",
        user="owner",
        created_at=now,
        updated_at=now,
    )
    session.add(conversation)
    session.flush()
    for index in range(105):
        session.add(AgentMessage(
            conversation_id=conversation.id,
            role="user",
            content=f"message-{index + 1}",
            created_at=now,
        ))
    session.commit()

    response = get_messages(session, conversation.id, limit=100)

    assert len(response.messages) == 100
    assert response.messages[0].content == "message-6"
    assert response.messages[-1].content == "message-105"
    assert [message.id for message in response.messages] == sorted(message.id for message in response.messages)
