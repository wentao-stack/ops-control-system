"""
SSE Event Protocol — Agent ↔ Frontend Event Bus
=================================================

Every SSE message follows this format:
  data: {"event": "<type>", ...payload}\n\n

Event Types (12 total):
────────────────────────

1. conv_id        — Conversation created / identified
2. thinking       — LLM is processing (show loading)
3. token          — Streaming text token (append to assistant message)
4. tool_call      — Agent is calling a tool (show tool card)
5. tool_progress  — Tool execution progress (show progress bar)
6. tool_result    — Tool execution completed (show result)
7. confirm        — Requires user confirmation (show dialog)
8. confirm_result — Confirmation response received
9. error          — Error occurred (show error toast)
10. warning       — Non-fatal warning (show warning banner)
11. usage         — Token usage stats (show in message footer)
12. done          — Stream complete (finalize UI)

Event Flow Examples:
────────────────────

Simple chat (no tools):
  conv_id → thinking → token → token → ... → token → usage → done

Tool call (read-level, auto-execute):
  conv_id → thinking → tool_call → tool_progress → tool_result → token → ... → done

Tool call (exec-level, requires confirm):
  conv_id → thinking → tool_call → confirm → [user approves] → confirm_result
    → tool_progress → tool_result → token → ... → done

Multiple tool calls:
  conv_id → thinking → tool_call → tool_result → tool_call → tool_result
    → thinking → token → ... → done

Error flow:
  conv_id → thinking → error → done
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid as _uuid
from typing import Any, AsyncIterator, TypedDict

import httpx

from .agent_models import AgentConversation, AgentMessage
from .agent_schemas import AgentChatRequest

# ── SSE Event Types ────────────────────────────────────────────────────────

SSE_EVENT_TYPES = [
    "conv_id",        # {"conv_id": str}
    "thinking",       # {"text": str}
    "token",          # {"token": str}
    "tool_call",      # {"id": str, "name": str, "params": dict, "level": str}
    "tool_progress",  # {"id": str, "message": str, "percent": int}
    "tool_result",    # {"id": str, "name": str, "result": str, "duration_ms": int}
    "confirm",        # {"id": str, "name": str, "params": dict, "level": str, "message": str}
    "confirm_result", # {"id": str, "approved": bool}
    "error",          # {"message": str, "code": str}
    "warning",        # {"message": str}
    "usage",          # {"prompt_tokens": int, "completion_tokens": int, "total_tokens": int, "tool_calls": int}
    "done",           # {}
]


# ── Dependencies (wired from agent.py) ─────────────────────────────────────

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


# ── SSE Helper ─────────────────────────────────────────────────────────────

def sse(event: str, **kwargs) -> str:
    """Format an SSE event line."""
    payload = {"event": event}
    payload.update(kwargs)
    return f'data: {json.dumps(payload, ensure_ascii=False)}\n\n'


# ── Intent Detection ──────────────────────────────────────────────────────

def detect_intent(user_message: str) -> dict | None:
    """Auto-detect tool call intent when LLM refuses to call tools."""
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


# ── Build LLM Messages from History ────────────────────────────────────────

def build_llm_messages(session, conv_id, memories_text):
    """Build LLM message list from conversation history."""
    from datetime import UTC, datetime

    history = (
        session.query(AgentMessage)
        .filter(AgentMessage.conversation_id == conv_id)
        .order_by(AgentMessage.id.asc())
        .limit(40)
        .all()
    )

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

    return llm_messages


def load_memories(session, user, user_message):
    """Load relevant memories with scoring."""
    from datetime import UTC, datetime
    from .models import AgentMemory

    all_memories = (
        session.query(AgentMemory)
        .filter(AgentMemory.user == user)
        .order_by(AgentMemory.updated_at.desc())
        .all()
    )

    user_lower = user_message.lower()
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

    return memories_text


# ── Main Agent Loop (Event Bus) ────────────────────────────────────────────

async def run_agent_graph(
    session: Any,
    req: AgentChatRequest,
    user: str,
    user_role: str = "admin",
) -> AsyncIterator[str]:
    """
    Agent execution engine — SSE event bus.

    Each yield is an SSE event pushed to the frontend in real-time.
    The frontend treats these as a command stream and updates the UI accordingly.
    """
    from datetime import UTC, datetime

    model = req.model or _DEFAULT_MODEL
    conv_id = req.conversation_id

    # ── Phase 1: Conversation setup ──────────────────────────────────────
    is_new = False
    if not conv_id:
        new_conv = _create_conversation(session, user, model)
        conv_id = new_conv.id
        is_new = True

    yield sse("conv_id", conv_id=conv_id)

    conv = (
        session.query(AgentConversation)
        .filter(AgentConversation.id == conv_id, AgentConversation.user == user)
        .first()
    )
    if conv is None:
        yield sse("error", message="Conversation not found", code="NOT_FOUND")
        yield sse("done")
        return

    # Save user message
    _save_message(session, conv_id, "user", req.message)

    # ── Phase 2: Build context ───────────────────────────────────────────
    memories_text = load_memories(session, user, req.message)
    llm_messages = build_llm_messages(session, conv_id, memories_text)
    tools_openai = _get_tools_openai()

    # ── Phase 3: Agent loop ──────────────────────────────────────────────
    max_iterations = 5
    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_tokens = 0
    tool_calls_count = 0
    final_content = ""

    for iteration in range(max_iterations):
        # Signal: LLM is thinking
        yield sse("thinking", text="正在分析...")

        # Call LLM (need full response to check tool_calls)
        try:
            assistant_msg = await _llm_chat_with_tools(model, llm_messages, tools_openai)
        except httpx.TimeoutException as e:
            yield sse("error", message=f"LLM 回應超時（模型可能正在載入，請稍後重試）: {type(e).__name__}")
            yield sse("done")
            return
        except Exception as e:
            yield sse("error", message=f"LLM 呼叫失敗: {type(e).__name__}: {e}")
            yield sse("done")
            return

        # Token tracking
        usage = assistant_msg.pop("_usage", None)
        if usage:
            total_prompt_tokens += usage.get("prompt_tokens", 0)
            total_completion_tokens += usage.get("completion_tokens", 0)
            total_tokens += usage.get("total_tokens", 0)

        llm_messages.append(assistant_msg)
        tool_calls = assistant_msg.get("tool_calls", [])

        # Intent detection on first iteration if LLM didn't call tools
        if not tool_calls and iteration == 0:
            auto_tool = detect_intent(req.message)
            if auto_tool:
                tool_calls = [auto_tool]

        # ── No tool calls = final response ──────────────────────────────
        if not tool_calls:
            final_content = assistant_msg.get("content", "") or ""
            # Stream tokens to frontend
            for i in range(0, len(final_content), 2):
                chunk = final_content[i:i + 2]
                yield sse("token", token=chunk)

            _save_message(session, conv_id, "assistant", final_content)
            break

        # ── Execute tool calls ──────────────────────────────────────────
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
            tool_call_id = f"tc-{_uuid.uuid4().hex[:8]}"

            # Signal: tool_call event
            yield sse("tool_call", id=tool_call_id, name=tool_name, params=tool_args, level=tool_level)

            # Permission check
            if not _check_tool_permission(user_role, tool_level):
                result = f"❌ 權限不足：無法使用 {tool_name}（需要 {tool_level} 權限）"
                yield sse("tool_result", id=tool_call_id, name=tool_name, result=result, duration_ms=0)
                tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
                llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", tool_call_id), "content": result})
                continue

            # Confirmation (exec-level tools)
            if requires_confirm:
                confirm_id = f"cf-{_uuid.uuid4().hex[:8]}"
                confirm_message = f"確認執行 {tool_name}？\n\n參數: {json.dumps(tool_args, ensure_ascii=False)}"

                yield sse("confirm", id=confirm_id, name=tool_name, params=tool_args, level=tool_level, message=confirm_message)

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
                    yield sse("confirm_result", id=confirm_id, approved=False)
                    yield sse("tool_result", id=tool_call_id, name=tool_name, result=result, duration_ms=0)
                    tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                    _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
                    _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                    llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", tool_call_id), "content": result})
                    continue
                except asyncio.CancelledError:
                    _confirm_store.pop(confirm_id, None)
                    result = "❌ 操作已取消"
                    yield sse("confirm_result", id=confirm_id, approved=False)
                    yield sse("tool_result", id=tool_call_id, name=tool_name, result=result, duration_ms=0)
                    tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                    _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
                    _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                    llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", tool_call_id), "content": result})
                    continue
                else:
                    _confirm_store.pop(confirm_id, None)
                    if not approved:
                        result = "❌ 用戶取消了操作"
                        yield sse("confirm_result", id=confirm_id, approved=False)
                        yield sse("tool_result", id=tool_call_id, name=tool_name, result=result, duration_ms=0)
                        tool_input_json = json.dumps(tool_args, ensure_ascii=False)
                        _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
                        _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=False)
                        llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", tool_call_id), "content": result})
                        continue
                    else:
                        yield sse("confirm_result", id=confirm_id, approved=True)

            # Execute tool with progress
            import time as _time
            start = _time.monotonic()

            yield sse("tool_progress", id=tool_call_id, message=f"正在執行 {tool_name}...", percent=50)

            if handler:
                try:
                    result = await handler.handler(tool_args, session)
                except Exception as e:
                    result = f"工具執行錯誤: {str(e)[:200]}"
                    yield sse("error", message=f"工具 {tool_name} 執行失敗: {str(e)[:100]}", code="TOOL_ERROR")
            else:
                result = f"未知工具: {tool_name}"

            duration_ms = int((_time.monotonic() - start) * 1000)

            yield sse("tool_progress", id=tool_call_id, message=f"{tool_name} 完成", percent=100)
            yield sse("tool_result", id=tool_call_id, name=tool_name, result=result, duration_ms=duration_ms)

            tool_input_json = json.dumps(tool_args, ensure_ascii=False)
            _save_message(session, conv_id, "tool", "", tool_name=tool_name, tool_input=tool_input_json, tool_result=result)
            _record_tool_call(session, conv_id, user, tool_name, tool_level, tool_input_json, result, confirmed=bool(requires_confirm), confirmed_by=user if requires_confirm else None)
            llm_messages.append({"role": "tool", "tool_call_id": tc.get("id", tool_call_id), "content": result})
        else:
            continue

    else:
        # Max iterations exceeded
        yield sse("warning", message="達到最大迭代次數，停止處理")
        yield sse("token", token="\n\n⚠ 達到最大迭代次數，停止處理")
        _save_message(session, conv_id, "assistant", "達到最大迭代次數，停止處理")

    # ── Phase 4: Post-processing ─────────────────────────────────────────

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

    # Token usage event
    if total_tokens > 0:
        yield sse("usage", prompt_tokens=total_prompt_tokens, completion_tokens=total_completion_tokens, total_tokens=total_tokens, tool_calls=tool_calls_count)

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
    yield sse("done")
