import pytest
from pydantic import ValidationError

from app.agent_schemas import (
    AgentChatRequest,
    AgentConversationCreate,
    AgentInspectRequest,
    AgentMemoryUpsert,
)


def test_agent_requests_do_not_override_configured_default_model():
    assert AgentChatRequest(message="hello").model is None
    assert AgentConversationCreate().model is None


def test_agent_requests_keep_explicit_model():
    model = "qwen36-27b-no-think-v1"

    assert AgentChatRequest(message="hello", model=model).model == model
    assert AgentConversationCreate(model=model).model == model


def test_agent_chat_message_is_trimmed_and_blank_is_rejected():
    assert AgentChatRequest(message="  hello  ").message == "hello"

    with pytest.raises(ValidationError):
        AgentChatRequest(message="   \n\t")


def test_agent_chat_message_has_a_safe_size_limit():
    with pytest.raises(ValidationError):
        AgentChatRequest(message="x" * 10_001)


def test_memory_payload_is_trimmed_and_category_is_validated():
    memory = AgentMemoryUpsert(key="  locale ", value=" zh-TW ", category="preference")
    assert memory.key == "locale"
    assert memory.value == "zh-TW"

    with pytest.raises(ValidationError):
        AgentMemoryUpsert(key="locale", value="zh-TW", category="invalid")


def test_system_inspection_is_read_only_by_default():
    assert AgentInspectRequest().create_notes is False
