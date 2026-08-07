"""LangGraph-based agent state machine.

Replaces the hand-written tool-calling loop with a structured StateGraph:

    START -> chatbot -> [has_tool_calls?]
                     -> invoke_tools -> [requires_confirm?]
                                  -> await_confirm -> invoke_tools
                     -> finalize -> END

Nodes:
  chatbot       — call LLM with tools, return assistant message
  invoke_tools  — execute tool calls, emit SSE events, handle permissions
  await_confirm — block on frontend confirmation (asyncio.Future)
  finalize      — stream final LLM response to frontend

Condition edges:
  chatbot -> has_tool_calls -> invoke_tools | no_tool_calls -> finalize
  invoke_tools -> has_confirm -> await_confirm | no_confirm -> chatbot
  await_confirm -> chatbot (always, after confirmation result)
  finalize -> END
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid as _uuid
from typing import Any, AsyncIterator, Literal, TypedDict

from langgraph.graph import StateGraph, END, START
from langgraph.graph.message import add_messages

from .agent_models import AgentConversation, AgentMessage
from .agent_schemas import AgentChatRequest

# ── Re-exported from agent.py to avoid circular imports ──────────────────────
# These are set at module load time by the caller.
_llm_chat_with_tools: Any = None
_llm_chat_stream: Any = None
_get_tools_openai: Any = None
_get_tool_handler: Any = None
_check_tool_permission: Any = None
_save_message: Any = None
_record_tool_call: Any = None
_build_system_prompt: Any = None
_generate_title: Any = None
_auto_extract_memories: Any = None
_create_conversation: Any = None
_DEFAULT_MODEL: str = ""
_LLM_API_KEY: str = ""
_confirm_store: Any = None


def init_graph_deps(
    _llm_chat_with_tools_fn: Any,
    _llm_chat_stream_fn: Any,
    _get_tools_openai_fn: Any,
    _get_tool_handler_fn: Any,
    _check_tool_permission_fn: Any,
    _save_message_fn: Any,
    _record_tool_call_fn: Any,
    _build_system_prompt_fn: Any,
    _generate_title_fn: Any,
    _auto_extract_memories_fn: Any,
    _create_conversation_fn: Any,
    _default_model: str,
    _llm_api_key: str,
    _confirm_store_dict: Any,
) -> None:
    """Wire up external dependencies from agent.py."""
    global _llm_chat_with_tools, _llm_chat_stream
    global _get_tools_openai, _get_tool_handler
    global _check_tool_permission, _save_message
    global _record_tool_call, _build_system_prompt
    global _generate_title, _auto_extract_memories
    global _create_conversation, _DEFAULT_MODEL
    global _LLM_API_KEY, _confirm_store

    _llm_chat_with_tools = _llm_chat_with_tools_fn
    _llm_chat_stream = _llm_chat_stream_fn
    _get_tools_openai = _get_tools_openai_fn
    _get_tool_handler = _get_tool_handler_fn
    _check_tool_permission = _check_tool_permission_fn
    _save_message = _save_message_fn
    _record_tool_call = _record_tool_call_fn
    _build_system_prompt = _build_system_prompt_fn
    _generate_title = _generate_title_fn
    _auto_extract_memories = _auto_extract_memories_fn
    _create_conversation = _create_conversation_fn
    _DEFAULT_MODEL = _default_model
    _LLM_API_KEY = _llm_api_key
    _confirm_store = _confirm_store_dict


# ── Agent State ──────────────────────────────────────────────────────────────


class AgentState(TypedDict):
    """LangGraph state for the agent chat loop."""
    # LLM message history (uses add_messages reducer)
    messages: list[Any]
    # Current assistant message (set by chatbot node)
    assistant_message: dict
    # Tool calls from current assistant message
    tool_calls: list[dict]
    # SSE events buffer — each node appends events here
    sse_events: list[str]
    # Iteration counter (incremented each chatbot->tools cycle)
    iteration: int
    # Max iterations before forcing finalize
    max_iterations: int
    # Token usage accumulators
    total_prompt_tokens: int
    total_completion_tokens: int
    total_tokens: int
    tool_calls_count: int
    # Context for DB operations
    conv_id: str
    user: str
    user_role: str
    model: str
    is_new: bool
    user_message: str
    # SQLAlchemy session (passed through, not modified)
    session: Any


# ── Nodes ────────────────────────────────────────────────────────────────────


async def chatbot_node(state: AgentState) -> dict:
    """Call LLM with tools, parse response, detect intent if LLM refuses."""
    messages = state["messages"]
    model = state["model"]
    iteration = state["iteration"]
    conv_id = state["conv_id"]
    user_role = state["user_role"]
    user_message = state["user_message"]
    session = state["session"]
    user = state["user"]

    tools_openai = _get_tools_openai()

    # Call LLM
    assistant_msg = await _llm_chat_with_tools(model, messages, tools_openai)

    # Accumulate token usage
    usage = assistant_msg.pop("_usage", None)
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0
    if usage:
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        total_tokens = usage.get("total_tokens", 0)

    # Append assistant message to LLM context
    messages.append(assistant_msg)

    tool_calls = assistant_msg.get("tool_calls", [])

    # Intent detection: ONLY on first iteration — if user asked to execute a command
    # but LLM refused without calling tools, auto-invoke so backend blacklist handles it.
    if not tool_calls and iteration == 0:
        content = assistant_msg.get("content", "") or ""

        auto_tool = None

        # Strict pattern: must match BOTH asset and command
        m_cmd = re.search(r"執行\s+(.+)$", user_message)
        m_asset = re.search(r"在\s+(.+?)\s+上", user_message)
        if m_cmd and m_asset:
            auto_tool = {
                "function": {
                    "name": "exec_ssh_command",
                    "arguments": json.dumps({
                        "asset_id": m_asset.group(1).strip(),
                        "command": m_cmd.group(1).strip(),
                    }, ensure_ascii=False),
                }
            }

        if not auto_tool:
            m_svc = re.search(r"(.+?)\s+服務", user_message)
            m_asset2 = re.search(r"在\s+(.+?)\s+上", user_message)
            if m_svc and m_asset2 and any(kw in user_message for kw in ["重啟", "停止", "啟動"]):
                auto_tool = {
                    "function": {
                        "name": "supervisor_action",
                        "arguments": json.dumps({
                            "asset_id": m_asset2.group(1).strip(),
                            "process_name": m_svc.group(1).strip(),
                            "action": "restart" if "重啟" in user_message else "stop",
                        }, ensure_ascii=False),
                    }
                }

        if auto_tool:
            tool_calls = [auto_tool]

    return {
        "messages": messages,
        "assistant_message": assistant_msg,
        "tool_calls": tool_calls,
        "iteration": iteration + 1,
        "total_prompt_tokens": state["total_prompt_tokens"] + prompt_tokens,
        "total_completion_tokens": state["total_completion_tokens"] + completion_tokens,
        "total_tokens": state["total_tokens"] + total_tokens,
    }


async def invoke_tools_node(state: AgentState) -> dict:
    """Execute tool calls, handle permissions, emit SSE events, wait for confirm."""
    tool_calls = state["tool_calls"]
    messages = state["messages"]
    conv_id = state["conv_id"]
    user = state["user"]
    user_role = state["user_role"]
    session = state["session"]
    iteration = state["iteration"]

    sse_events: list[str] = []
    needs_confirm = False
    tool_calls_count = state["tool_calls_count"]

    for tc in tool_calls:
        tool_calls_count += 1
        func = tc.get("function", {})
        tool_name = func.get("name", "")
        tool_args_str = func.get("arguments", "{}")

        # Parse arguments
        try:
            tool_args = json.loads(tool_args_str) if isinstance(tool_args_str, str) else tool_args_str
        except json.JSONDecodeError:
            tool_args = {}

        # Check if tool requires confirmation
        handler = _get_tool_handler(tool_name)
        requires_confirm = handler and handler.requires_confirm
        tool_level = handler.level if handler else "read"

        # Permission check
        if not _check_tool_permission(user_role, tool_level):
            result = f"❌ 權限不足：無法使用 {tool_name}（需要 {tool_level} 權限）"
            sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))
            tool_input_json = json.dumps(tool_args, ensure_ascii=False)
            _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
            _save_message(
                session, conv_id, "tool", "",
                tool_name=tool_name,
                tool_input=tool_input_json,
                tool_result=result,
            )
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", f"call_{iteration}"),
                "content": result,
            })
            continue

        # Emit tool_use event to frontend
        sse_events.append(json.dumps({"event": "tool_use", "name": tool_name, "parameters": tool_args, "requires_confirm": requires_confirm}))

        # If requires confirmation, wait for frontend response
        if requires_confirm:
            confirm_id = f"cf-{_uuid.uuid4().hex[:8]}"

            # Emit confirm event with ID
            sse_events.append(json.dumps({"event": "confirm", "confirm_id": confirm_id, "name": tool_name, "parameters": tool_args, "level": tool_level}))

            # Use asyncio.Future for awaitable confirmation
            loop = asyncio.get_running_loop()
            confirm_future: asyncio.Future[bool] = loop.create_future()
            confirm_result: dict = {"approved": False}

            # Register in global store
            _confirm_store[confirm_id] = (confirm_future, confirm_result)

            # Wait for confirmation with timeout (5 minutes)
            try:
                approved = await asyncio.wait_for(confirm_future, timeout=300)
            except asyncio.TimeoutError:
                confirm_future.cancel()
                _confirm_store.pop(confirm_id, None)
                result = "⏰ 用戶未在限時內確認操作，已取消"
                tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))
                _save_message(
                    session, conv_id, "tool", "",
                    tool_name=tool_name,
                    tool_input=tool_input_json,
                    tool_result=result,
                )
                _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", f"call_{iteration}"),
                    "content": result,
                })
                continue
            except asyncio.CancelledError:
                _confirm_store.pop(confirm_id, None)
                result = "❌ 操作已取消"
                tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))
                _save_message(
                    session, conv_id, "tool", "",
                    tool_name=tool_name,
                    tool_input=tool_input_json,
                    tool_result=result,
                )
                _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", f"call_{iteration}"),
                    "content": result,
                })
                continue
            else:
                _confirm_store.pop(confirm_id, None)
                if not approved:
                    result = "❌ 用戶取消了操作"
                    tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                    sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))
                    _save_message(
                        session, conv_id, "tool", "",
                        tool_name=tool_name,
                        tool_input=tool_input_json,
                        tool_result=result,
                    )
                    _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", f"call_{iteration}"),
                        "content": result,
                    })
                    continue

        # Execute the tool (either no confirm needed or confirmed)
        if handler:
            try:
                result = await handler.handler(tool_args, session)
            except Exception as e:
                result = f"工具執行錯誤: {str(e)[:200]}"
        else:
            result = f"未知工具: {tool_name}"

        # Emit tool_result event to frontend
        sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))

        tool_input_json = json.dumps(tool_args, ensure_ascii=False)

        # Save tool message to DB
        _save_message(
            session, conv_id, "tool", "",
            tool_name=tool_name,
            tool_input=tool_input_json,
            tool_result=result,
        )

        # Audit log
        _record_tool_call(
            session, conv_id, user, tool_name, tool_level,
            tool_input_json, result,
            confirmed=bool(requires_confirm),
            confirmed_by=user if requires_confirm else None,
        )

        # Append tool result to LLM context
        messages.append({
            "role": "tool",
            "tool_call_id": tc.get("id", f"call_{iteration}"),
            "content": result,
        })

    return {
        "messages": messages,
        "sse_events": sse_events,
        "tool_calls_count": tool_calls_count,
    }


async def finalize_node(state: AgentState) -> dict:
    """Stream the final assistant response to frontend."""
    assistant_msg = state["assistant_message"]
    conv_id = state["conv_id"]
    session = state["session"]

    sse_events: list[str] = []
    content = assistant_msg.get("content", "") or ""

    # Stream content in chunks
    for i in range(0, len(content), 4):
        chunk = content[i:i + 4]
        sse_events.append(json.dumps({"event": "token", "token": chunk}))

    # Save final assistant message
    _save_message(session, conv_id, "assistant", content)

    return {
        "sse_events": sse_events,
    }


# ── Routing functions ────────────────────────────────────────────────────────


def route_after_chatbot(state: AgentState) -> Literal["invoke_tools", "finalize"]:
    """If assistant has tool_calls, go execute them. Otherwise finalize."""
    if state["tool_calls"]:
        return "invoke_tools"
    return "finalize"


def route_after_tools(state: AgentState) -> Literal["chatbot", "finalize"]:
    """After tools: if max iterations reached, finalize. Otherwise loop back."""
    if state["iteration"] >= state["max_iterations"]:
        return "finalize"
    return "chatbot"


# ── Graph construction ───────────────────────────────────────────────────────

# Build the graph once at module load
_builder = StateGraph(AgentState)
_builder.add_node("chatbot", chatbot_node)
_builder.add_node("invoke_tools", invoke_tools_node)
_builder.add_node("finalize", finalize_node)

_builder.add_edge(START, "chatbot")
_builder.add_conditional_edges("chatbot", route_after_chatbot, {"invoke_tools": "invoke_tools", "finalize": "finalize"})
_builder.add_edge("invoke_tools", "chatbot")
_builder.add_edge("finalize", END)

graph = _builder.compile()


# ── Public entry point ───────────────────────────────────────────────────────


async def run_agent_graph(
    session: Any,
    req: AgentChatRequest,
    user: str,
    user_role: str = "admin",
) -> AsyncIterator[str]:
    """
    Run the agent chat loop via LangGraph and yield SSE events.

    This replaces the hand-written for-loop in the original chat_stream.
    The SSE event format is identical so the frontend needs no changes.
    """
    from datetime import UTC, datetime

    model = req.model or _DEFAULT_MODEL
    conv_id = req.conversation_id

    # Auto-create conversation if none provided
    is_new = False
    if not conv_id:
        new_conv = _create_conversation(session, user, model)
        conv_id = new_conv.id
        is_new = True

    # Tell frontend the actual conversation id
    yield f'data: {json.dumps({"event": "conv_id", "conv_id": conv_id})}\n\n'

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
    _save_message(session, conv_id, "user", req.message)

    # Build message history for LLM
    history = (
        session.query(AgentMessage)
        .filter(AgentMessage.conversation_id == conv_id)
        .order_by(AgentMessage.id.asc())
        .limit(40)
        .all()
    )

    # Load user memories for system prompt context (relevance-aware)
    from .models import AgentMemory
    all_memories = (
        session.query(AgentMemory)
        .filter(AgentMemory.user == user)
        .order_by(AgentMemory.updated_at.desc())
        .all()
    )
    # Relevance scoring: memories matching keywords in user message get priority
    user_lower = req.message.lower()
    scored = []
    for m in all_memories:
        score = 0
        if m.key.lower() in user_lower:
            score += 10
        if any(word in user_lower for word in m.value.lower().split() if len(word) >= 2):
            score += 5
        if m.category == "preference" and any(kw in user_lower for kw in ["偏好", "喜歡", "習慣"]):
            score += 3
        if m.category == "environment" and any(kw in user_lower for kw in ["伺服器", "環境", "部署", "配置", "IP", "端口"]):
            score += 3
        if m.updated_at:
            ua = m.updated_at.replace(tzinfo=UTC) if m.updated_at.tzinfo is None else m.updated_at
            if (datetime.now(UTC) - ua).days < 30:
                score += 2
        scored.append((score, m))

    scored.sort(key=lambda x: (-x[0], x[1].updated_at or datetime.min.replace(tzinfo=UTC)))
    memories = [m for _, m in scored[:20]]

    memories_text = ""
    if memories:
        groups: dict[str, list] = {}
        for m in memories:
            groups.setdefault(m.category, []).append(f"- {m.key}: {m.value}")
        for cat, items in groups.items():
            memories_text += f"[{cat}]\n" + "\n".join(items) + "\n"

    # Build initial LLM messages
    llm_messages: list[dict] = [{"role": "system", "content": _build_system_prompt(memories_text)}]
    for m in history:
        if m.role == "tool" and m.tool_name:
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
            if m.role == "assistant" and m.content:
                refusal_kws = ["禁止執行", "極高的破壞性", "拒絕執行", "高風險破壞性命令"]
                if any(kw in m.content for kw in refusal_kws):
                    continue
            llm_messages.append({"role": m.role, "content": m.content})

    # ── Build initial state ──────────────────────────────────────────────
    initial_state: AgentState = {
        "messages": llm_messages,
        "assistant_message": {},
        "tool_calls": [],
        "sse_events": [],
        "iteration": 0,
        "max_iterations": 5,
        "total_prompt_tokens": 0,
        "total_completion_tokens": 0,
        "total_tokens": 0,
        "tool_calls_count": 0,
        "conv_id": conv_id,
        "user": user,
        "user_role": user_role,
        "model": model,
        "is_new": is_new,
        "user_message": req.message,
        "session": session,
    }

    # ── Run the graph, collecting SSE events ─────────────────────────────
    # We use graph.invoke() which runs the full graph and returns the final state.
    # Each node appends its SSE events to state["sse_events"], which we yield
    # after each node completes.
    #
    # To get per-node events, we use graph.stream() with stream_mode="values"
    # which yields the state after each node execution.

    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_tokens = 0
    tool_calls_count = 0

    try:
        for stream_chunk in graph.stream(initial_state):
            # stream_chunk is {node_name: partial_state} in langgraph 1.x
            for _node_name, partial_state in stream_chunk.items():
                # Yield SSE events accumulated by this node
                for evt in partial_state.get("sse_events", []):
                    yield f'data: {evt}\n\n'

                # Accumulate token usage
                total_prompt_tokens = partial_state.get("total_prompt_tokens", 0)
                total_completion_tokens = partial_state.get("total_completion_tokens", 0)
                total_tokens = partial_state.get("total_tokens", 0)
                tool_calls_count = partial_state.get("tool_calls_count", 0)
    except Exception as e:
        error_text = f"\n\n⚠ Agent 執行錯誤: {str(e)[:200]}"
        yield f'data: {json.dumps({"event": "token", "token": error_text})}\n\n'
        _save_message(session, conv_id, "assistant", f"Agent 執行錯誤: {str(e)[:200]}")

    # ── Post-processing ──────────────────────────────────────────────────

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

    # Record token usage
    if total_tokens > 0:
        try:
            from .models import AgentUsage
            usage_record = AgentUsage(
                user=user,
                conversation_id=conv_id,
                model=model,
                prompt_tokens=total_prompt_tokens,
                completion_tokens=total_completion_tokens,
                total_tokens=total_tokens,
                tool_calls_count=tool_calls_count,
                created_at=datetime.now(UTC),
            )
            session.add(usage_record)
            session.commit()
        except Exception:
            pass

    # Auto-extract memories from user message
    try:
        await _auto_extract_memories(req.message, user, session)
    except Exception:
        pass

    # Done signal
    yield f'data: {json.dumps({"event": "done"})}\n\n'
