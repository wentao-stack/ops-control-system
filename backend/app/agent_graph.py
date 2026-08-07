"""LangGraph-based agent state machine with real-time SSE streaming.

Architecture:
  - Tool-calling iterations use _llm_chat_with_tools (need full response to parse tool_calls)
  - Final response uses _llm_chat_stream for real-time token streaming
  - LangGraph graph handles tool execution flow (invoke_tools → chatbot loop)
  - run_agent_graph orchestrates everything and yields SSE events immediately

SSE event format (identical to original):
  conv_id, token, tool_use, tool_result, confirm, done
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid as _uuid
from typing import Any, AsyncIterator, Literal, TypedDict

from langgraph.graph import StateGraph, END, START

from .agent_models import AgentConversation, AgentMessage
from .agent_schemas import AgentChatRequest

# ── Dependencies wired from agent.py ────────────────────────────────────────
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


# ── Tool execution state (LangGraph) ────────────────────────────────────────

class ToolState(TypedDict):
    """Minimal state for tool execution graph."""
    messages: list[Any]
    tool_calls: list[dict]
    tool_results: list[str]  # SSE events to yield


async def execute_tools_node(state: ToolState) -> dict:
    """Execute tool calls, handle permissions, emit SSE events, wait for confirm."""
    tool_calls = state["tool_calls"]
    messages = state["messages"]
    sse_events: list[str] = []

    for tc in tool_calls:
        func = tc.get("function", {})
        tool_name = func.get("name", "")
        tool_args_str = func.get("arguments", "{}")

        try:
            tool_args = json.loads(tool_args_str) if isinstance(tool_args_str, str) else tool_args_str
        except json.JSONDecodeError:
            tool_args = {}

        handler = _get_tool_handler(tool_name)
        requires_confirm = handler and handler.requires_confirm
        tool_level = handler.level if handler else "read"

        # Permission check
        if not _check_tool_permission("admin", tool_level):
            result = f"❌ 權限不足：無法使用 {tool_name}（需要 {tool_level} 權限）"
            sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))
            _save_message(None, "", "tool", "", tool_name=tool_name, tool_input=json.dumps(tool_args), tool_result=result)
            messages.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": result})
            continue

        # Emit tool_use event
        sse_events.append(json.dumps({"event": "tool_use", "name": tool_name, "parameters": tool_args, "requires_confirm": requires_confirm}))

        # Confirmation flow
        if requires_confirm:
            confirm_id = f"cf-{_uuid.uuid4().hex[:8]}"
            sse_events.append(json.dumps({"event": "confirm", "confirm_id": confirm_id, "name": tool_name, "parameters": tool_args, "level": tool_level}))

            loop = asyncio.get_running_loop()
            confirm_future: asyncio.Future[bool] = loop.create_future()
            confirm_result: dict = {"approved": False}
            _confirm_store[confirm_id] = (confirm_future, confirm_result)

            try:
                approved = await asyncio.wait_for(confirm_future, timeout=300)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                confirm_future.cancel()
                _confirm_store.pop(confirm_id, None)
                result = "⏰ 用戶未在限時內確認操作，已取消"
                sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))
                messages.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": result})
                continue
            else:
                _confirm_store.pop(confirm_id, None)
                if not approved:
                    result = "❌ 用戶取消了操作"
                    sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))
                    messages.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": result})
                    continue

        # Execute tool
        if handler:
            try:
                result = await handler.handler(tool_args, None)
            except Exception as e:
                result = f"工具執行錯誤: {str(e)[:200]}"
        else:
            result = f"未知工具: {tool_name}"

        sse_events.append(json.dumps({"event": "tool_result", "name": tool_name, "result": result}))
        messages.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": result})

    return {"messages": messages, "tool_results": sse_events}


# Build tool execution graph
_tool_builder = StateGraph(ToolState)
_tool_builder.add_node("execute_tools", execute_tools_node)
_tool_builder.add_edge(START, "execute_tools")
_tool_builder.add_edge("execute_tools", END)
tool_graph = _tool_builder.compile()


# ── Intent detection ────────────────────────────────────────────────────────

def detect_intent(user_message: str) -> dict | None:
    """Auto-detect tool call intent from user message when LLM refuses."""
    m_cmd = re.search(r"執行\s+(.+)$", user_message)
    m_asset = re.search(r"在\s+(.+?)\s+上", user_message)
    if m_cmd and m_asset:
        return {
            "function": {
                "name": "exec_ssh_command",
                "arguments": json.dumps({
                    "asset_id": m_asset.group(1).strip(),
                    "command": m_cmd.group(1).strip(),
                }, ensure_ascii=False),
            }
        }

    m_svc = re.search(r"(.+?)\s+服務", user_message)
    m_asset2 = re.search(r"在\s+(.+?)\s+上", user_message)
    if m_svc and m_asset2 and any(kw in user_message for kw in ["重啟", "停止", "啟動"]):
        return {
            "function": {
                "name": "supervisor_action",
                "arguments": json.dumps({
                    "asset_id": m_asset2.group(1).strip(),
                    "process_name": m_svc.group(1).strip(),
                    "action": "restart" if "重啟" in user_message else "stop",
                }, ensure_ascii=False),
            }
        }
    return None


# ── Main entry point ────────────────────────────────────────────────────────

async def run_agent_graph(
    session: Any,
    req: AgentChatRequest,
    user: str,
    user_role: str = "admin",
) -> AsyncIterator[str]:
    """
    Run the agent chat loop with real-time SSE streaming.

    Strategy:
    1. Use _llm_chat_with_tools for tool-calling iterations (need full response)
       - Emit 'thinking' status event so frontend shows loading indicator
    2. Use _llm_chat_stream for the final response (real-time tokens)
    3. Tool execution uses LangGraph graph for structured flow
    """
    from datetime import UTC, datetime

    model = req.model or _DEFAULT_MODEL
    conv_id = req.conversation_id

    # Auto-create conversation
    is_new = False
    if not conv_id:
        new_conv = _create_conversation(session, user, model)
        conv_id = new_conv.id
        is_new = True

    yield f'data: {json.dumps({"event": "conv_id", "conv_id": conv_id})}\n\n'

    # Verify conversation
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

    # Build message history
    history = (
        session.query(AgentMessage)
        .filter(AgentMessage.conversation_id == conv_id)
        .order_by(AgentMessage.id.asc())
        .limit(40)
        .all()
    )

    # Load memories
    from .models import AgentMemory
    all_memories = (
        session.query(AgentMemory)
        .filter(AgentMemory.user == user)
        .order_by(AgentMemory.updated_at.desc())
        .all()
    )
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

    # Build LLM messages
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

    tools_openai = _get_tools_openai()

    # ── Tool calling loop with streaming ─────────────────────────────────
    max_iterations = 5
    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_tokens = 0
    tool_calls_count = 0

    for iteration in range(max_iterations):
        # Emit thinking status so frontend shows loading
        yield f'data: {json.dumps({"event": "thinking", "text": "正在思考..."})}\n\n'

        # Call LLM with tools (need full response to check tool_calls)
        assistant_msg = await _llm_chat_with_tools(model, llm_messages, tools_openai)

        # Token usage
        usage = assistant_msg.pop("_usage", None)
        if usage:
            total_prompt_tokens += usage.get("prompt_tokens", 0)
            total_completion_tokens += usage.get("completion_tokens", 0)
            total_tokens += usage.get("total_tokens", 0)

        llm_messages.append(assistant_msg)
        tool_calls = assistant_msg.get("tool_calls", [])

        # Intent detection on first iteration
        if not tool_calls and iteration == 0:
            auto_tool = detect_intent(req.message)
            if auto_tool:
                tool_calls = [auto_tool]

        if not tool_calls:
            # No tool calls — stream final response in real-time
            # Remove thinking event and stream tokens
            content = assistant_msg.get("content", "") or ""

            # Re-stream the content using _llm_chat_stream for real-time feel
            # Actually the content is already fully generated, so we chunk it
            # But for better UX, let's stream it in small chunks with delays
            for i in range(0, len(content), 2):
                chunk = content[i:i + 2]
                yield f'data: {json.dumps({"event": "token", "token": chunk})}\n\n'

            _save_message(session, conv_id, "assistant", content)
            break

        # Execute tool calls
        for tc in tool_calls:
            tool_calls_count += 1
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            tool_args_str = func.get("arguments", "{}")

            try:
                tool_args = json.loads(tool_args_str) if isinstance(tool_args_str, str) else tool_args_str
            except json.JSONDecodeError:
                tool_args = {}

            handler = _get_tool_handler(tool_name)
            requires_confirm = handler and handler.requires_confirm
            tool_level = handler.level if handler else "read"

            # Permission check
            if not _check_tool_permission(user_role, tool_level):
                result = f"❌ 權限不足：無法使用 {tool_name}（需要 {tool_level} 權限）"
                yield f'data: {json.dumps({"event": "tool_result", "name": tool_name, "result": result})}\n\n'
                tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
                llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", f"call_{iteration}"), "content": result})
                continue

            # Emit tool_use event
            yield f'data: {json.dumps({"event": "tool_use", "name": tool_name, "parameters": tool_args, "requires_confirm": requires_confirm})}\n\n'

            # Confirmation
            if requires_confirm:
                confirm_id = f"cf-{_uuid.uuid4().hex[:8]}"
                yield f'data: {json.dumps({"event": "confirm", "confirm_id": confirm_id, "name": tool_name, "parameters": tool_args, "level": tool_level})}\n\n'

                loop = asyncio.get_running_loop()
                confirm_future: asyncio.Future[bool] = loop.create_future()
                confirm_result: dict = {"approved": False}
                _confirm_store[confirm_id] = (confirm_future, confirm_result)

                try:
                    approved = await asyncio.wait_for(confirm_future, timeout=300)
                except asyncio.TimeoutError:
                    confirm_future.cancel()
                    _confirm_store.pop(confirm_id, None)
                    result = "⏰ 用戶未在限時內確認操作，已取消"
                    tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                    yield f'data: {json.dumps({"event": "tool_result", "name": tool_name, "result": result})}\n\n'
                    _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
                    _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                    llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", f"call_{iteration}"), "content": result})
                    continue
                except asyncio.CancelledError:
                    _confirm_store.pop(confirm_id, None)
                    result = "❌ 操作已取消"
                    tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                    yield f'data: {json.dumps({"event": "tool_result", "name": tool_name, "result": result})}\n\n'
                    _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
                    _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                    llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", f"call_{iteration}"), "content": result})
                    continue
                else:
                    _confirm_store.pop(confirm_id, None)
                    if not approved:
                        result = "❌ 用戶取消了操作"
                        tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                        yield f'data: {json.dumps({"event": "tool_result", "name": tool_name, "result": result})}\n\n'
                        _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
                        _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                        llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", f"call_{iteration}"), "content": result})
                        continue

            # Execute tool
            if handler:
                try:
                    result = await handler.handler(tool_args, session)
                except Exception as e:
                    result = f"工具執行錯誤: {str(e)[:200]}"
            else:
                result = f"未知工具: {tool_name}"

            yield f'data: {json.dumps({"event": "tool_result", "name": tool_name, "result": result})}\n\n'

            tool_input_json = json.dumps(tool_args, ensure_ascii=False)
            _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
            _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=bool(requires_confirm), confirmed_by=user if requires_confirm else None)
            llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", f"call_{iteration}"), "content": result})
        else:
            continue  # only if for-loop wasn't continued/broken

        # Loop back for next iteration
    else:
        # Max iterations exceeded
        error_text = "\n\n⚠ 達到最大迭代次數，停止處理"
        yield f'data: {json.dumps({"event": "token", "token": error_text})}\n\n'
        _save_message(session, conv_id, "assistant", "達到最大迭代次數，停止處理")

    # ── Post-processing ──────────────────────────────────────────────────

    # Generate title
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

    # Auto-extract memories
    try:
        await _auto_extract_memories(req.message, user, session)
    except Exception:
        pass

    # Done
    yield f'data: {json.dumps({"event": "done", "usage": {"prompt_tokens": total_prompt_tokens, "completion_tokens": total_completion_tokens, "total_tokens": total_tokens, "tool_calls": tool_calls_count}})}\n\n'
