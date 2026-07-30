from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy.orm import Session

from .workflow_models import WorkflowExecution, WorkflowTemplate

# ── LLM helper ─────────────────────────────────────────────────────────────

LLM_API_KEY = os.getenv("OPENAI_API_KEY", "")
LLM_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("AGENT_DEFAULT_MODEL", "gpt-4o-mini")


async def _llm_complete(system: str, user: str) -> str:
    """Call LLM for content generation."""
    if not LLM_API_KEY:
        return "[LLM API key not configured]"

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {LLM_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.3,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


# ── Step executors ─────────────────────────────────────────────────────────

async def _run_llm_step(config: dict, context: dict) -> dict:
    """LLM step: generate content with system + user prompt templates."""
    system_prompt = config.get("system_prompt", "You are a helpful assistant.")
    user_prompt = config.get("user_prompt", "")

    # Template rendering: replace {{variable}} with context values
    def render(template: str) -> str:
        result = template
        for key, value in context.items():
            result = result.replace("{{" + key + "}}", str(value))
        return result

    system = render(system_prompt)
    user = render(user_prompt)

    content = await _llm_complete(system, user)
    return {"content": content}


async def _run_api_step(config: dict, context: dict) -> dict:
    """API step: make an HTTP request."""
    def render(template: str) -> str:
        result = template
        for key, value in context.items():
            result = result.replace("{{" + key + "}}", str(value))
        return result

    url = render(config.get("url", ""))
    method = config.get("method", "GET")
    headers = config.get("headers", {})
    body = config.get("body", None)

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.request(method, url, headers=headers, json=body)
        resp.raise_for_status()
        return {"status": resp.status_code, "data": resp.json()}


async def _run_shell_step(config: dict, context: dict) -> dict:
    """Shell step: execute a command locally if no host, or via SSH if host specified."""
    command = config.get("command", "")
    host = config.get("host", "")

    if not command:
        return {"status": "skipped", "message": "No command specified, step skipped"}

    if not host:
        # Execute locally
        import subprocess
        try:
            result = subprocess.run(
                command, shell=True, capture_output=True, text=True, timeout=60
            )
            return {
                "status": "completed",
                "exit_code": result.returncode,
                "stdout": result.stdout[:2000],
                "stderr": result.stderr[:2000],
            }
        except subprocess.TimeoutExpired:
            return {"error": "Command timed out (60s)"}
        except Exception as e:
            return {"error": str(e)}

    # Remote SSH execution
    from .remote import ssh_exec

    # Parse host:port
    port = 22
    if ":" in host:
        h, p = host.rsplit(":", 1)
        host = h
        try:
            port = int(p)
        except ValueError:
            port = 22

    # Look up SSH user from assets
    from .database import SessionLocal
    from .models import Asset
    user = "root"
    with SessionLocal() as session:
        asset = session.query(Asset).filter(Asset.ssh_host == host).first()
        if asset and asset.ssh_user:
            user = asset.ssh_user

    result = ssh_exec(host, port, user, command, timeout=60)
    return result


async def _run_note_api_step(config: dict, context: dict) -> dict:
    """Note API step: call the Notes API via HTTP."""
    method = config.get("method", "GET").upper()
    path = config.get("path", "")
    fields = config.get("fields") or {}

    if not path:
        return {"error": "No path specified"}

    # Merge configured defaults with runtime parameters. The workflow editor can
    # intentionally leave fields empty and collect their values only when the
    # workflow is run, so limiting this merge to ``fields.items()`` would drop
    # every runtime value and send an empty request body.
    merged_fields: dict[str, Any] = {}
    for key, val in fields.items():
        if key in context and context[key] not in ("", None):
            merged_fields[key] = context[key]
        elif val not in ("", None):
            merged_fields[key] = val
        else:
            merged_fields[key] = val

    note_field_names = {
        "id", "title", "content", "category", "tags", "pinned", "published",
        "page", "page_size", "search",
    }
    for key in note_field_names:
        if key in context and context[key] not in ("", None):
            merged_fields[key] = context[key]

    # Replace path params like {id} with field values
    final_path = path
    for key, val in merged_fields.items():
        final_path = final_path.replace("{" + key + "}", str(val))

    # Build request body for POST/PUT
    body_keys = {"title", "content", "category", "tags", "pinned", "published"}
    body = {k: v for k, v in merged_fields.items() if k in body_keys and v not in ("", None)}

    # The workflow form accepts tags as a convenient comma-separated string,
    # while NoteCreate expects a JSON list.
    if isinstance(body.get("tags"), str):
        raw_tags = body["tags"].strip()
        if raw_tags.startswith("["):
            try:
                parsed_tags = json.loads(raw_tags)
            except json.JSONDecodeError:
                parsed_tags = None
            if isinstance(parsed_tags, list):
                body["tags"] = parsed_tags
            else:
                body["tags"] = [tag.strip() for tag in raw_tags.split(",") if tag.strip()]
        else:
            body["tags"] = [tag.strip() for tag in raw_tags.replace("，", ",").split(",") if tag.strip()]

    import httpx as _httpx

    base_url = os.getenv("OPS_API_BASE_URL", "http://127.0.0.1:18080")
    url = f"{base_url}{final_path}"

    async with _httpx.AsyncClient(timeout=30) as client:
        headers = {}
        token = context.get("_auth_token")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if method == "GET":
            resp = await client.get(url, headers=headers)
        elif method == "POST":
            resp = await client.post(url, json=body, headers=headers)
        elif method == "PUT":
            resp = await client.put(url, json=body, headers=headers)
        elif method == "DELETE":
            resp = await client.delete(url, headers=headers)
        else:
            return {"error": f"Unsupported method: {method}"}

    return {
        "status": resp.status_code,
        "data": resp.json() if resp.status_code != 204 else None,
    }


async def _run_note_create_step(config: dict, context: dict) -> dict:
    """Note create step: create a note directly via DB (no HTTP loopback)."""
    from uuid import uuid4

    # Priority: explicit note_* fields > topic/summary > defaults
    title = context.get("note_title", context.get("topic", "工作流生成文檔"))
    content = context.get("note_content", context.get("summary", ""))
    category = context.get("note_category", context.get("category", "知識"))
    tags = context.get("note_tags", context.get("tags", []))
    pinned = context.get("note_pinned", False)

    # Import here to avoid circular import
    from .models import Note
    import json as _json

    # Create note directly in DB
    from .database import SessionLocal
    note_id = title[:32].replace(" ", "-") + str(uuid4())[:8]
    now = datetime.now(UTC).replace(microsecond=0)

    with SessionLocal() as session:
        note = Note(
            id=note_id,
            title=title,
            category=category,
            content=content,
            tags=_json.dumps(tags, ensure_ascii=False),
            author="system",
            pinned=pinned,
            published=True,
            created_at=now,
            updated_at=now,
        )
        session.add(note)
        session.commit()

    return {
        "note_id": note_id,
        "note_url": f"/notes/{note_id}",
    }


# ── Engine ─────────────────────────────────────────────────────────────────

STEP_EXECUTORS = {
    "llm": _run_llm_step,
    "api": _run_api_step,
    "note_create": _run_note_create_step,
    "shell": _run_shell_step,
    "note_api": _run_note_api_step,
}


async def run_workflow(
    template: WorkflowTemplate,
    parameters: dict,
    user: str,
    session: Session,
    auth_token: str | None = None,
) -> WorkflowExecution:
    """Execute a workflow template with given parameters."""
    # Parse template
    steps = json.loads(template.steps_json)
    param_defs = json.loads(template.parameters_schema)

    # Apply defaults
    for param_def in param_defs:
        if param_def["name"] not in parameters and param_def.get("default") is not None:
            parameters[param_def["name"]] = param_def["default"]

    # Validate required params
    missing = [p["name"] for p in param_defs if p.get("required") and p["name"] not in parameters]
    if missing:
        raise ValueError(f"Missing required parameters: {', '.join(missing)}")

    # Create execution record
    now = datetime.now(UTC).replace(microsecond=0)
    execution = WorkflowExecution(
        template_id=template.id,
        parameters_json=json.dumps(parameters, ensure_ascii=False),
        status="running",
        user=user,
        started_at=now,
    )
    session.add(execution)
    session.commit()

    # Execute steps sequentially
    context = dict(parameters)
    if auth_token:
        context["_auth_token"] = auth_token
    step_results: list[dict] = []

    try:
        for step in steps:
            step_type = step.get("type", "")
            step_name = step.get("name", "")
            step_config = step.get("config", {})

            executor = STEP_EXECUTORS.get(step_type)
            if executor is None:
                raise ValueError(f"Unknown step type: {step_type}")

            # Merge step-specific config into context
            step_result = await executor(step_config, context)

            # Store step result in context for subsequent steps
            context[f"step_{step_name}"] = step_result

            # If step type is llm, extract content for note_create step
            if step_type == "llm" and "content" in step_result:
                context["llm_output"] = step_result["content"]
                # Auto-set note_content for next note_create step if not already set
                if "note_content" not in context:
                    context["note_content"] = step_result["content"]
                # Auto-set note_title from feature_name if available
                if "note_title" not in context and "feature_name" in context:
                    context["note_title"] = f"{context['feature_name']} — 技術文檔"

            # If note_create step, use llm_output as content if note_content not set
            if step_type == "note_create":
                if "note_content" not in context and "llm_output" in context:
                    context["note_content"] = context["llm_output"]
                if "note_title" not in context:
                    context["note_title"] = f"工作流文檔 — {template.name}"

            step_results.append({"step": step_name, "status": "completed", "result": step_result})

        # Mark as completed
        execution.status = "completed"
        execution.result_json = json.dumps(step_results, ensure_ascii=False)
        execution.completed_at = datetime.now(UTC).replace(microsecond=0)

    except Exception as e:
        execution.status = "failed"
        execution.error = str(e)
        execution.completed_at = datetime.now(UTC).replace(microsecond=0)

    session.commit()
    return execution
