from app.agent_schemas import AgentChatRequest, AgentConversationCreate


def test_agent_requests_do_not_override_configured_default_model():
    assert AgentChatRequest(message="hello").model is None
    assert AgentConversationCreate().model is None


def test_agent_requests_keep_explicit_model():
    model = "qwen36-27b-no-think-v1"

    assert AgentChatRequest(message="hello", model=model).model == model
    assert AgentConversationCreate(model=model).model == model
