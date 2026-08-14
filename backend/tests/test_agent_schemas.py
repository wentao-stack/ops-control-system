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


def test_agent_chat_request_accepts_supported_ui_locale():
    assert AgentChatRequest(message="hello", locale="en").locale == "en"
    assert AgentChatRequest(message="こんにちは", locale="ja").locale == "ja"

    with pytest.raises(ValidationError):
        AgentChatRequest(message="hello", locale="fr")


def test_system_prompt_requires_the_requested_reply_language():
    from app.agent import build_system_prompt

    assert "Respond in English" in build_system_prompt(locale="en")
    assert "日本語で回答" in build_system_prompt(locale="ja")


def test_host_metrics_tool_result_uses_requested_locale_and_safe_missing_values():
    from app.agent import format_host_metrics_results

    results = [{
        "name": "archlinux",
        "asset_id": "asset-1",
        "cpu_percent": 12.5,
        "cpu_count": 4,
        "mem_used_mb": 512,
        "mem_total_mb": 1024,
        "mem_percent": 50.0,
        "disk_used_gb": None,
        "disk_total_gb": None,
        "disk_percent": 25.0,
        "gpu": [],
    }]

    english = format_host_metrics_results(results, "en")
    japanese = format_host_metrics_results(results, "ja")

    assert "Memory: 512MB / 1024MB" in english
    assert "Disk: -GB / -GB" in english
    assert "記憶體" not in english and "磁碟" not in english
    assert "メモリ: 512MB / 1024MB" in japanese
    assert "ディスク: -GB / -GB" in japanese


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
