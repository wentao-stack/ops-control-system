"""ComfyUI 整合模組 — 動態工作流、參數注入、提交、進度串流。

對接本機 ComfyUI (預設 http://127.0.0.1:8188)：
- 工作流: 即時讀取 ComfyUI userdata/workflows，支援 API 與平面 UI JSON
- 提交: POST /prompt
- 進度: WebSocket /ws 轉成事件串流 (progress / executing / done / error)
- 輸出: /history 解析 + /view 代理預覽

環境變數:
- COMFYUI_BASE_URL (預設 http://127.0.0.1:8188)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import random
import re
import subprocess
import time
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import quote

import httpx
import websockets

logger = logging.getLogger(__name__)

COMFY_BASE = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip("/")
WS_BASE = COMFY_BASE.replace("http://", "ws://", 1)
COMFY_INPUT_DIR = Path(os.environ.get("COMFYUI_INPUT_DIR", "/home/wentao/project/ComfyUI/input"))
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFYUI_OUTPUT_DIR", "/home/wentao/project/ComfyUI/output"))
COMFY_TEMP_DIR = Path(os.environ.get("COMFYUI_TEMP_DIR", "/home/wentao/project/ComfyUI/temp"))
COMFY_THUMBNAIL_DIR = Path(os.environ.get("COMFYUI_THUMBNAIL_DIR", "/tmp/ocs-comfy-thumbnails"))

_TIMEOUT = httpx.Timeout(60.0, connect=5.0)

# ── 動態工作流發現 ────────────────────────────────────────────────────────

_object_info_cache: dict[str, Any] | None = None
_object_info_cached_at = 0.0


async def _get_object_info() -> dict[str, Any]:
    """取得 ComfyUI 節點 schema；短暫快取避免每次重新下載約 3MB。"""
    global _object_info_cache, _object_info_cached_at
    now = time.monotonic()
    if _object_info_cache is not None and now - _object_info_cached_at < 60:
        return _object_info_cache
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(f"{COMFY_BASE}/object_info")
        response.raise_for_status()
        _object_info_cache = response.json()
        _object_info_cached_at = now
    return _object_info_cache


async def _list_workflow_files() -> list[dict[str, Any]]:
    """直接讀取 ComfyUI userdata，讓新工作流不需在本專案重複註冊。"""
    params = {"dir": "workflows", "recurse": "true", "full_info": "true"}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(f"{COMFY_BASE}/userdata", params=params)
        response.raise_for_status()
        files = response.json()
    if not isinstance(files, list):
        raise ValueError("ComfyUI 回傳的工作流清單格式無效")
    # 新版 full_info=true 回傳物件；舊版則回傳純字串路徑。
    normalized: list[dict[str, Any]] = []
    for item in files:
        if isinstance(item, str):
            path = item
            info: dict[str, Any] = {"path": path}
        elif isinstance(item, dict) and isinstance(item.get("path"), str):
            path = item["path"]
            info = item
        else:
            continue
        if path.lower().endswith(".json"):
            normalized.append(info)
    return normalized


async def _read_workflow_file(path: str) -> dict[str, Any]:
    encoded = quote(_userdata_path(path), safe="")
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(f"{COMFY_BASE}/userdata/{encoded}")
        response.raise_for_status()
        workflow = response.json()
    if not isinstance(workflow, dict):
        raise ValueError("工作流根節點必須是 JSON object")
    return workflow


def _workflow_id(path: str) -> str:
    return f"wf-{hashlib.sha256(path.encode('utf-8')).hexdigest()[:24]}"


def _userdata_path(path: str) -> str:
    """Return a validated public userdata path for a workflow file."""
    normalized = path.replace("\\", "/").strip("/")
    parts = normalized.split("/")
    if (
        not normalized
        or any(part in {"", ".", ".."} for part in parts)
        or not normalized.lower().endswith(".json")
    ):
        raise ValueError("無效的工作流路徑")
    return f"workflows/{normalized}"


async def _find_workflow_path(workflow_id: str) -> str | None:
    for file_info in await _list_workflow_files():
        path = file_info["path"]
        if _workflow_id(path) == workflow_id:
            return path
    return None


def _workflow_rename_path(path: str, new_name: str) -> str:
    """Build a same-directory target path and reject traversal or extensions other than JSON."""
    candidate = new_name.strip()
    if not candidate:
        raise ValueError("請輸入工作流名稱")
    if "/" in candidate or "\\" in candidate or candidate in {".", ".."}:
        raise ValueError("名稱不可包含資料夾或路徑字元")
    if not candidate.lower().endswith(".json"):
        candidate += ".json"
    if not re.fullmatch(r"[^/\\]+\.json", candidate, re.IGNORECASE):
        raise ValueError("工作流名稱必須以 .json 結尾")
    return str(Path(path).parent / candidate) if Path(path).parent != Path(".") else candidate


def _input_spec(node_info: dict[str, Any], name: str) -> tuple[Any, dict[str, Any], bool] | None:
    inputs = node_info.get("input") or {}
    for section, required in (("required", True), ("optional", False)):
        spec = (inputs.get(section) or {}).get(name)
        if isinstance(spec, list) and spec:
            config = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            return spec[0], config, required
    return None


def _is_widget_spec(spec: tuple[Any, dict[str, Any], bool] | None) -> bool:
    if spec is None:
        return False
    input_type, config, _ = spec
    if config.get("forceInput"):
        return False
    return isinstance(input_type, list) or input_type in {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}


def _ordered_input_names(node_info: dict[str, Any]) -> list[str]:
    order = node_info.get("input_order") or {}
    if order:
        return list(order.get("required") or []) + list(order.get("optional") or [])
    inputs = node_info.get("input") or {}
    return list((inputs.get("required") or {}).keys()) + list((inputs.get("optional") or {}).keys())


def compile_ui_workflow(workflow: dict[str, Any], object_info: dict[str, Any]) -> dict[str, Any]:
    """把不含子圖的 ComfyUI UI workflow 轉成 /prompt 接受的 API 格式。

    UI JSON 的 ``mode: 4`` 表示節點在畫布上被 bypass。這個狀態屬於編輯器，
    而不是 API prompt 的一部分；工作台執行時仍需保留原節點與連線，否則一個
    被整組 bypass 的工作流會被誤判成不可執行。``mode: 2`` 的靜音節點則不會
    產生輸出，應略過。
    """
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("不是 ComfyUI UI 工作流")
    subgraphs = ((workflow.get("definitions") or {}).get("subgraphs") or [])
    if subgraphs:
        raise ValueError("包含子圖；請在 ComfyUI 將工作流匯出為 API 格式後再執行")

    nodes_by_id = {str(node.get("id")): node for node in nodes if isinstance(node, dict)}
    links_by_target: dict[tuple[str, int], tuple[str, int]] = {}
    links_by_target_name: dict[tuple[str, str], tuple[str, int]] = {}
    for link in workflow.get("links") or []:
        if isinstance(link, list) and len(link) >= 5:
            links_by_target[(str(link[3]), int(link[4]))] = (str(link[1]), int(link[2]))
        elif isinstance(link, dict):
            target_id = link.get("target_id")
            target_slot = link.get("target_slot")
            origin_id = link.get("origin_id")
            origin_slot = link.get("origin_slot")
            if None not in (target_id, target_slot, origin_id, origin_slot):
                if isinstance(origin_slot, str):
                    origin_node = nodes_by_id.get(str(origin_id)) or {}
                    outputs = origin_node.get("outputs") or []
                    origin_slot = next(
                        (index for index, output in enumerate(outputs) if output.get("name") == origin_slot),
                        None,
                    )
                if origin_slot is None:
                    continue
                source = (str(origin_id), int(origin_slot))
                if isinstance(target_slot, str):
                    links_by_target_name[(str(target_id), target_slot)] = source
                else:
                    links_by_target[(str(target_id), int(target_slot))] = source

    prompt: dict[str, Any] = {}
    missing_types: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict) or node.get("mode", 0) == 2:
            continue
        node_id = str(node.get("id"))
        class_type = str(node.get("type", ""))
        node_info = object_info.get(class_type)
        if not isinstance(node_info, dict):
            # 註解、標籤等純 UI 節點不在 /object_info 中，也沒有資料流；略過它們
            # 就能讓含 rgthree Label / MarkdownNote 的一般工作流正常執行。
            inputs = node.get("inputs") or []
            outputs = node.get("outputs") or []
            has_input_link = any(isinstance(item, dict) and item.get("link") is not None for item in inputs)
            has_output_link = any(
                isinstance(item, dict) and bool(item.get("links")) for item in outputs
            )
            if has_input_link or has_output_link:
                missing_types.add(class_type)
            continue

        node_inputs = node.get("inputs") or []
        connected: dict[str, list[Any]] = {}
        widget_names: list[str] = []
        for slot, node_input in enumerate(node_inputs):
            if not isinstance(node_input, dict) or not node_input.get("name"):
                continue
            name = str(node_input["name"])
            link = links_by_target_name.get((node_id, name)) or links_by_target.get((node_id, slot))
            if link is not None:
                connected[name] = [link[0], link[1]]
            if node_input.get("widget") is not None:
                widget_names.append(name)

        values = node.get("widgets_values")
        widget_values: dict[str, Any] = {}
        if isinstance(values, dict):
            widget_values.update(values)
        elif isinstance(values, list):
            if not widget_names:
                widget_names = [
                    name for name in _ordered_input_names(node_info)
                    if _is_widget_spec(_input_spec(node_info, name))
                ]
            value_index = 0
            for name in widget_names:
                if value_index >= len(values):
                    break
                widget_values[name] = values[value_index]
                value_index += 1
                spec = _input_spec(node_info, name)
                if spec and spec[1].get("control_after_generate") and value_index < len(values):
                    value_index += 1

        api_inputs: dict[str, Any] = dict(widget_values)
        api_inputs.update(connected)
        title = node.get("title") or (node.get("properties") or {}).get("Node name for S&R")
        prompt[node_id] = {
            "inputs": api_inputs,
            "class_type": class_type,
            "_meta": {"title": title or node_info.get("display_name") or class_type},
        }

    if missing_types:
        missing = ", ".join(sorted(t for t in missing_types if t))
        raise ValueError(f"ComfyUI 缺少節點：{missing}")
    if not prompt:
        raise ValueError("工作流沒有可執行節點")
    return _keep_output_dependencies(prompt)


_OUTPUT_NODE_TYPES = {"SaveImage", "SaveVideo", "VHS_VideoCombine", "PreviewImage", "PreviewAny"}


def _keep_output_dependencies(prompt: dict[str, Any]) -> dict[str, Any]:
    """Discard UI-only and inactive branches that do not feed an output node.

    A ComfyUI canvas can contain several experimental branches.  The API does
    not carry canvas bypass state, so submitting every node accidentally asks
    ComfyUI to validate branches that are not part of the rendered video.
    """
    output_ids = {
        node_id for node_id, node in prompt.items()
        if str(node.get("class_type")) in _OUTPUT_NODE_TYPES
    }
    if not output_ids:
        return prompt
    required = set(output_ids)
    pending = list(output_ids)
    while pending:
        node_id = pending.pop()
        inputs = (prompt.get(node_id) or {}).get("inputs") or {}
        for value in inputs.values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in prompt:
                source_id = str(value[0])
                if source_id not in required:
                    required.add(source_id)
                    pending.append(source_id)
    return {node_id: node for node_id, node in prompt.items() if node_id in required}


def _is_api_workflow(workflow: dict[str, Any]) -> bool:
    return bool(workflow) and all(
        isinstance(node, dict) and isinstance(node.get("class_type"), str)
        for node in workflow.values()
    )


def _display_name(path: str) -> str:
    name = Path(path).stem.replace("_", " ").replace("-", " ")
    return " ".join(part.upper() if part.lower() in {"h3", "i2v", "t2v", "api", "ltx"} else part for part in name.split())


def _workflow_presentation(prompt: dict[str, Any]) -> tuple[str, str, str | None]:
    class_types = [str(node.get("class_type", "")) for node in prompt.values()]
    lowered = " ".join(class_types).lower()
    if any(key in lowered for key in ("video", "vhs", "movie")):
        output_kind, icon = "video", "🎬"
    elif "audio" in lowered:
        output_kind, icon = "audio", "🎧"
    else:
        output_kind, icon = "image", "✨"

    model = None
    for node in prompt.values():
        class_type = str(node.get("class_type", "")).lower()
        if any(key in class_type for key in ("checkpointloader", "unetloader", "diffusionmodelload")):
            inputs = node.get("inputs") or {}
            model = inputs.get("ckpt_name") or inputs.get("unet_name") or inputs.get("model_name")
            if model:
                model = Path(str(model)).name
                break
    return output_kind, icon, model


_COMMON_INPUTS = {
    "prompt", "text", "negative_prompt", "negative", "image", "seed", "noise_seed",
    "width", "height", "length", "steps", "video_steps", "audio_steps", "cfg", "denoise",
    "strength", "strength_model", "fps", "frame_rate", "batch_size", "task_type", "audio_mode",
}


def _param_definition(
    node_id: str,
    class_type: str,
    node: dict[str, Any],
    input_name: str,
    value: Any,
    node_info: dict[str, Any],
) -> dict[str, Any] | None:
    spec = _input_spec(node_info, input_name)
    if not _is_widget_spec(spec):
        return None
    input_type, config, required = spec
    options: list[Any] | None = None
    if isinstance(input_type, list):
        options = input_type
    elif input_type == "COMBO":
        options = config.get("options")

    lowered = input_name.lower()
    if class_type == "LoadImage" and input_name == "image":
        param_type = "image"
        options = None
    elif "seed" in lowered:
        param_type = "seed"
    elif options is not None:
        param_type = "select"
    elif input_type == "BOOLEAN":
        param_type = "boolean"
    elif input_type == "STRING":
        param_type = "textarea" if config.get("multiline") or "prompt" in lowered or "text" in lowered else "text"
    elif input_type in {"INT", "FLOAT"}:
        param_type = "number"
    else:
        return None

    node_title = (node.get("_meta") or {}).get("title") or node_info.get("display_name") or class_type
    label = input_name.replace("_", " ").strip().title()
    return {
        "key": f"{node_id}:{input_name}",
        "label": label,
        "type": param_type,
        "required": required,
        "default": value,
        "min": config.get("min"),
        "max": config.get("max"),
        "step": config.get("step"),
        "options": [str(option) for option in options] if options is not None else None,
        "help": config.get("tooltip"),
        "advanced": bool(config.get("advanced")) or lowered not in _COMMON_INPUTS,
        "node_id": node_id,
        "node_title": str(node_title),
        "targets": [{"node": node_id, "input": input_name}],
    }


def _extract_params(prompt: dict[str, Any], object_info: dict[str, Any]) -> list[dict[str, Any]]:
    params: list[dict[str, Any]] = []
    for node_id, node in prompt.items():
        class_type = str(node.get("class_type", ""))
        node_info = object_info.get(class_type) or {}
        for input_name, value in (node.get("inputs") or {}).items():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in prompt:
                continue
            definition = _param_definition(node_id, class_type, node, input_name, value, node_info)
            if definition:
                params.append(definition)
    return _normalize_duration_params(params, prompt)


def _missing_required_inputs(prompt: dict[str, Any], object_info: dict[str, Any]) -> list[str]:
    """Return unconnected ``forceInput`` values that a UI conversion cannot supply.

    ComfyUI marks some widget-backed fields as ``required`` even when their
    empty/default value is valid.  Only ``forceInput`` means a literal link is
    mandatory and cannot be filled in by this page's parameter form.
    """
    missing: list[str] = []
    for node_id, node in prompt.items():
        node_info = object_info.get(str(node.get("class_type"))) or {}
        required = (node_info.get("input") or {}).get("required") or {}
        inputs = node.get("inputs") or {}
        for input_name, spec in required.items():
            config = spec[1] if isinstance(spec, list) and len(spec) > 1 and isinstance(spec[1], dict) else {}
            if config.get("forceInput") and input_name not in inputs:
                title = (node.get("_meta") or {}).get("title") or node.get("class_type") or node_id
                missing.append(f"{title} · {input_name}")
    return missing


def repair_unconnected_force_inputs(prompt: dict[str, Any], object_info: dict[str, Any]) -> list[str]:
    """Connect a unique compatible producer for a dangling forceInput.

    A few saved TE MAN workflows contain the companion ``TE_prompt_text`` node
    but omit its second output link to the enhancer.  The node schema makes
    that link mandatory.  This generic, conservative repair only acts when
    exactly one output in the prompt has the required Comfy type.
    """
    repairs: list[str] = []
    outputs: dict[str, list[tuple[str, int]]] = {}
    for source_id, source in prompt.items():
        source_info = object_info.get(str(source.get("class_type"))) or {}
        for output_index, output_type in enumerate(source_info.get("output") or []):
            if isinstance(output_type, str):
                outputs.setdefault(output_type, []).append((str(source_id), output_index))

    for node_id, node in prompt.items():
        node_info = object_info.get(str(node.get("class_type"))) or {}
        required = (node_info.get("input") or {}).get("required") or {}
        inputs = node.setdefault("inputs", {})
        for input_name, spec in required.items():
            config = spec[1] if isinstance(spec, list) and len(spec) > 1 and isinstance(spec[1], dict) else {}
            input_type = spec[0] if isinstance(spec, list) and spec else None
            if not config.get("forceInput") or input_name in inputs or not isinstance(input_type, str):
                continue
            candidates = [candidate for candidate in outputs.get(input_type, []) if candidate[0] != str(node_id)]
            if len(candidates) == 1:
                inputs[input_name] = [candidates[0][0], candidates[0][1]]
                title = (node.get("_meta") or {}).get("title") or node.get("class_type") or node_id
                repairs.append(f"{title} · {input_name}")
    return repairs


def _selector_options(spec: tuple[Any, dict[str, Any], bool] | None) -> list[Any]:
    """Return the current enum values exposed by a ComfyUI input schema."""
    if spec is None:
        return []
    input_type, config, _ = spec
    if isinstance(input_type, list):
        return input_type
    options = config.get("options")
    return options if isinstance(options, list) else []


def _selector_basename(value: str) -> str:
    """Normalize old Windows/Comfy model paths to a comparable filename."""
    return value.replace("\\", "/").rsplit("/", 1)[-1].casefold()


def normalize_workflow_selectors(
    prompt: dict[str, Any], object_info: dict[str, Any]
) -> tuple[list[str], list[str]]:
    """Adapt saved model selectors to the ComfyUI instance currently in use.

    Workflows are often shared between machines and may retain a directory
    prefix (for example ``Minimax_H3\\model.safetensors``).  ComfyUI validates
    these selectors against its live list and rejects the whole prompt when it
    only exposes ``model.safetensors``.  Match a unique basename automatically;
    report genuinely unavailable values before submitting instead of returning a
    cryptic HTTP 400.
    """
    adjusted: list[str] = []
    unavailable: list[str] = []
    for node_id, node in prompt.items():
        class_type = str(node.get("class_type") or "")
        node_info = object_info.get(class_type) or {}
        inputs = node.get("inputs") or {}
        for input_name, value in inputs.items():
            # A two-item list pointing at another prompt node is a graph link,
            # not a COMBO value.
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in prompt:
                continue
            if not isinstance(value, str):
                continue
            spec = _input_spec(node_info, input_name)
            # LoadImage is an upload field.  A missing saved image is handled by
            # the form/preflight below, so it must not make the whole template
            # unavailable before the user has a chance to provide a new file.
            if class_type == "LoadImage" and input_name == "image":
                continue
            options = _selector_options(spec)
            string_options = [option for option in options if isinstance(option, str)]
            if not string_options or value in string_options:
                continue
            matched = [option for option in string_options if _selector_basename(option) == _selector_basename(value)]
            if not matched:
                # Some saved UI values combine the enum code with a translated
                # label ("I2VA — 图生音视频"), while other nodes now expose a
                # shorter filename ("mmproj-BF16.gguf").  Accept either only
                # when it identifies one live option unambiguously.
                normalized = _selector_basename(value)
                code = re.split(r"\s|—|－|-", normalized, maxsplit=1)[0]
                matched = [option for option in string_options if _selector_basename(option) == code]
                if not matched:
                    matched = [
                        option for option in string_options
                        if normalized.endswith(_selector_basename(option))
                        or _selector_basename(option).endswith(normalized)
                    ]
            title = (node.get("_meta") or {}).get("title") or class_type or node_id
            if len(matched) == 1:
                inputs[input_name] = matched[0]
                adjusted.append(f"{title} · {input_name}")
            else:
                unavailable.append(f"{title} · {input_name}（{value}）")
    return adjusted, unavailable


async def normalize_workflow_selectors_live(prompt: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Normalize against a freshly cached live schema immediately before queueing."""
    return normalize_workflow_selectors(prompt, await _get_object_info())


def _workflow_frame_rate(prompt: dict[str, Any]) -> float:
    """Find the FPS used by the workflow's video output, with a safe fallback."""
    preferred_classes = ("CreateVideo", "VHS_VideoCombine")
    for preferred in preferred_classes:
        for node in prompt.values():
            if node.get("class_type") != preferred:
                continue
            inputs = node.get("inputs") or {}
            for name in ("fps", "frame_rate"):
                value = inputs.get(name)
                if isinstance(value, (int, float)) and value > 0:
                    return float(value)
    for node in prompt.values():
        inputs = node.get("inputs") or {}
        for name in ("fps", "frame_rate"):
            value = inputs.get(name)
            if isinstance(value, (int, float)) and value > 0:
                return float(value)
    return 24.0


def _normalize_duration_params(
    params: list[dict[str, Any]],
    prompt: dict[str, Any],
) -> list[dict[str, Any]]:
    """Expose frame-based length inputs as one duration-in-seconds parameter."""
    length_params = [param for param in params if param.get("key", "").lower().endswith(":length")]
    if not length_params:
        return params

    fps = _workflow_frame_rate(prompt)
    first = length_params[0]
    raw_default = first.get("default")
    default_seconds = max(1, math.floor(raw_default / fps)) if isinstance(raw_default, (int, float)) else 5
    raw_max = first.get("max")
    max_seconds = max(1, math.floor(raw_max / fps)) if isinstance(raw_max, (int, float)) else None
    targets: list[dict[str, Any]] = []
    for param in length_params:
        frame_step = param.get("step")
        frame_min = param.get("min")
        for original_target in param.get("targets", []):
            target = {**original_target, "multiply": fps}
            if isinstance(frame_step, (int, float)) and frame_step > 1:
                snap_mod = int(frame_step)
                snap_min = int(frame_min) if isinstance(frame_min, (int, float)) else 0
                target.update({
                    "snap_mod": snap_mod,
                    "snap_rem": snap_min % snap_mod,
                    "snap_min": snap_min,
                })
            targets.append(target)

    duration = {
        **first,
        "key": "duration_seconds",
        "label": "生成时间长度",
        "type": "number",
        "default": default_seconds,
        "min": 1,
        "max": max_seconds,
        "step": 1,
        "unit": "秒",
        "help": f"输入期望时长；后端按 {fps:g} FPS 换算，并自动对齐为 ComfyUI 模型允许的帧数。",
        "node_title": "视频生成",
        "targets": targets,
    }
    first_index = params.index(first)
    without_lengths = [param for param in params if param not in length_params]
    without_lengths.insert(first_index, duration)
    return without_lengths


async def _build_workflow(file_info: dict[str, Any], object_info: dict[str, Any]) -> dict[str, Any]:
    path = file_info["path"]
    raw = await _read_workflow_file(path)
    workflow_format = "api" if _is_api_workflow(raw) else "ui"
    runnable = True
    disabled_reason = None
    try:
        prompt = raw if workflow_format == "api" else compile_ui_workflow(raw, object_info)
    except ValueError as exc:
        prompt = {}
        runnable = False
        disabled_reason = str(exc)

    if runnable:
        _, unavailable_selectors = normalize_workflow_selectors(prompt, object_info)
        if unavailable_selectors:
            runnable = False
            disabled_reason = "ComfyUI 目前找不到工作流所需模型或選項：" + "、".join(unavailable_selectors[:3])

    if runnable:
        repair_unconnected_force_inputs(prompt, object_info)
        missing_inputs = _missing_required_inputs(prompt, object_info)
        if missing_inputs:
            runnable = False
            disabled_reason = "工作流缺少必要連線：" + "、".join(missing_inputs[:3])

    params = _extract_params(prompt, object_info) if runnable else []
    for param in params:
        if param["type"] != "image" or not param.get("default"):
            continue
        image_path = COMFY_INPUT_DIR / str(param["default"])
        if not image_path.is_file():
            param["default"] = ""
            param["help"] = "原本的圖片檔已不存在，請重新上傳圖片。"

    output_kind, icon, model = _workflow_presentation(prompt)
    modified = file_info.get("modified")
    return {
        "id": _workflow_id(path),
        "name": _display_name(path),
        "description": f"同步自 ComfyUI · {workflow_format.upper()} 工作流",
        "category": output_kind,
        "icon": icon,
        "model": model,
        "output_kind": output_kind,
        "params": params,
        "filename": path,
        "workflow_format": workflow_format,
        "node_count": len(prompt) if runnable else len(raw.get("nodes") or []),
        "updated_at": modified,
        "runnable": runnable,
        "disabled_reason": disabled_reason,
        "workflow": prompt,
    }


async def list_workflows() -> list[dict[str, Any]]:
    object_info = await _get_object_info()
    workflows: list[dict[str, Any]] = []
    for file_info in await _list_workflow_files():
        try:
            workflows.append(await _build_workflow(file_info, object_info))
        except Exception as exc:
            logger.warning("工作流解析失敗 %s: %s", file_info.get("path"), exc)
            workflows.append({
                "id": _workflow_id(file_info["path"]),
                "name": _display_name(file_info["path"]),
                "description": "同步自 ComfyUI · 無法解析",
                "category": "general",
                "icon": "⚠️",
                "output_kind": "image",
                "params": [],
                "filename": file_info["path"],
                "workflow_format": "unknown",
                "node_count": 0,
                "updated_at": file_info.get("modified"),
                "runnable": False,
                "disabled_reason": str(exc),
                "workflow": {},
            })
    return sorted(workflows, key=lambda item: (not item["runnable"], item["name"].lower()))


async def get_workflow(workflow_id: str) -> dict[str, Any] | None:
    object_info = await _get_object_info()
    for file_info in await _list_workflow_files():
        if _workflow_id(file_info["path"]) == workflow_id:
            return await _build_workflow(file_info, object_info)
    return None


async def rename_workflow(workflow_id: str, new_name: str) -> dict[str, Any] | None:
    """Rename one existing workflow through ComfyUI userdata without changing its contents."""
    path = await _find_workflow_path(workflow_id)
    if path is None:
        return None
    target = _workflow_rename_path(path, new_name)
    if target == path:
        raise ValueError("工作流名稱沒有變更")
    source_path = quote(_userdata_path(path), safe="")
    target_path = quote(_userdata_path(target), safe="")
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(
            f"{COMFY_BASE}/userdata/{source_path}/move/{target_path}",
            params={"overwrite": "false"},
        )
        if response.status_code == 409:
            raise FileExistsError("同名工作流已存在")
        response.raise_for_status()
    return {"id": _workflow_id(target), "filename": target}


async def delete_workflow(workflow_id: str) -> bool:
    """Delete an existing workflow through ComfyUI userdata."""
    path = await _find_workflow_path(workflow_id)
    if path is None:
        return False
    encoded = quote(_userdata_path(path), safe="")
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.delete(f"{COMFY_BASE}/userdata/{encoded}")
        if response.status_code == 404:
            return False
        response.raise_for_status()
    return True


# ── 參數注入 ──────────────────────────────────────────────────────────────


def inject_params(workflow: dict[str, Any], template: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    """依 meta 的 targets 把使用者參數寫入工作流節點。seed = -1 時隨機化。"""
    for p in template.get("params", []):
        key = p.get("key", "")
        if key not in params or params[key] is None:
            continue
        value = params[key]
        if p.get("type") == "seed":
            try:
                value = int(value)
            except (TypeError, ValueError):
                value = -1
            if value <= 0:
                value = random.randint(0, 2**31 - 1)
        for tgt in p.get("targets", []):
            node_id = str(tgt.get("node", ""))
            input_name = tgt.get("input", "")
            node = workflow.get(node_id)
            if node is None:
                logger.warning("注入失敗：工作流缺少節點 %s", node_id)
                continue
            node.setdefault("inputs", {})[input_name] = value
            # target 級轉換（例如 秒 → 幀數 ×24）
            if tgt.get("multiply") and isinstance(value, (int, float)):
                v = math.ceil(value * tgt["multiply"])
                # H3 幀數需 ≡5 (mod 17)（模型結構要求，來自原工作流公式）
                if tgt.get("snap_mod") and isinstance(v, (int, float)):
                    rem = v % tgt["snap_mod"]
                    target_rem = tgt.get("snap_rem", 0)
                    if rem != target_rem:
                        v += (target_rem - rem) % tgt["snap_mod"]
                    v = max(v, tgt.get("snap_min", 0))
                node["inputs"][input_name] = v
    return workflow


# ── ComfyUI API ──────────────────────────────────────────────────────────


async def get_status() -> dict[str, Any]:
    """ComfyUI 健康狀態 + GPU + 佇列。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            ss_r = await client.get(f"{COMFY_BASE}/system_stats")
            q_r = await client.get(f"{COMFY_BASE}/queue")
        except Exception as e:
            return {"online": False, "error": str(e)}
        if ss_r.status_code != 200:
            return {"online": False, "error": f"HTTP {ss_r.status_code}"}
        ss = ss_r.json()
        q = q_r.json() if q_r.status_code == 200 else {}
    devices = []
    for d in ss.get("devices", []):
        devices.append(
            {
                "name": d.get("name"),
                "vram_total": d.get("vram_total"),
                "vram_free": d.get("vram_free"),
            }
        )
    return {
        "online": True,
        "comfyui_version": (ss.get("system") or {}).get("comfyui_version"),
        "devices": devices,
        "queue_running": len(q.get("queue_running", []) or []),
        "queue_pending": len(q.get("queue_pending", []) or []),
    }


async def submit_workflow(workflow: dict[str, Any]) -> str:
    """提交工作流，回傳 prompt_id。

    使用固定的 _WS_CLIENT_ID 提交 — ComfyUI 的執行事件只 unicast 給提交時的
    clientId 對應的 socket，所以監聽端必須用同一個 clientId。
    """
    ensure_ws()
    try:
        await asyncio.wait_for(_ws_ready.wait(), timeout=15.0)
    except asyncio.TimeoutError:
        raise ConnectionError("無法連線 ComfyUI WebSocket")
    payload = {"prompt": workflow, "client_id": _WS_CLIENT_ID}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(f"{COMFY_BASE}/prompt", json=payload)
        if r.is_error:
            detail = r.text.strip().replace("\n", " ")[:1_000]
            raise ValueError(f"ComfyUI 拒絕工作流（HTTP {r.status_code}）：{detail or '未提供詳細原因'}")
        prompt_id = r.json()["prompt_id"]
    _job_node_titles[prompt_id] = {
        str(node_id): str((node.get("_meta") or {}).get("title") or node.get("class_type") or f"節點 {node_id}")
        for node_id, node in workflow.items()
        if isinstance(node, dict)
    }
    make_job_queue(prompt_id)
    return prompt_id


async def get_history(prompt_id: str) -> dict[str, Any] | None:
    """查詢單一 prompt 的執行歷史；不存在回傳 None。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(f"{COMFY_BASE}/history/{prompt_id}")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise httpx.HTTPStatusError(f"history HTTP {r.status_code}", request=r.request, response=r)
        return r.json().get(prompt_id)


async def get_queue_prompt_ids() -> set[str]:
    """目前在 ComfyUI 佇列中的 prompt_id 集合（執行中 + 排隊）。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            r = await client.get(f"{COMFY_BASE}/queue")
            q = r.json()
        except Exception:
            return set()
    ids: set[str] = set()
    for item in (q.get("queue_running", []) or []) + (q.get("queue_pending", []) or []):
        if isinstance(item, list) and len(item) > 1 and isinstance(item[1], str):
            ids.add(item[1])
    return ids


async def get_prompt_queue_state(prompt_id: str) -> tuple[str, int | None] | None:
    """返回 running 或 queued 及排队位置；任务不在队列时返回 None。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            r = await client.get(f"{COMFY_BASE}/queue")
            r.raise_for_status()
            queue = r.json()
        except Exception:
            return None
    for item in queue.get("queue_running", []) or []:
        if isinstance(item, list) and len(item) > 1 and item[1] == prompt_id:
            return "running", None
    for position, item in enumerate(queue.get("queue_pending", []) or [], start=1):
        if isinstance(item, list) and len(item) > 1 and item[1] == prompt_id:
            return "queued", position
    return None


_KIND_BY_EXT = {
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
    ".gif": "gif",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".wav": "audio", ".mp3": "audio", ".flac": "audio", ".aac": "audio", ".ogg": "audio",
}
_output_artifact_cache: tuple[float, list[dict[str, Any]]] | None = None
_OUTPUT_ARTIFACT_CACHE_TTL = 60.0


def list_output_artifacts(
    offset: int = 0, limit: int = 24, refresh: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    """列出 ComfyUI output 目錄中的作品，分頁時重用短期檔案索引避免重複掃盤。"""
    global _output_artifact_cache
    cached = _output_artifact_cache
    now = time.monotonic()
    if not refresh and cached and now - cached[0] < _OUTPUT_ARTIFACT_CACHE_TTL:
        artifacts = cached[1]
        return artifacts[offset:offset + limit], len(artifacts)
    root = COMFY_OUTPUT_DIR.resolve()
    if not root.is_dir():
        return [], 0
    artifacts: list[dict[str, Any]] = []
    for candidate in root.rglob("*"):
        try:
            resolved = candidate.resolve()
            relative = resolved.relative_to(root)
        except (OSError, ValueError):
            continue
        if not resolved.is_file():
            continue
        kind = _KIND_BY_EXT.get(resolved.suffix.lower())
        if not kind:
            continue
        try:
            modified_at = resolved.stat().st_mtime
        except OSError:
            continue
        artifacts.append({
            "id": hashlib.sha256(relative.as_posix().encode("utf-8")).hexdigest()[:32],
            "filename": relative.name,
            "subfolder": relative.parent.as_posix() if relative.parent != Path(".") else "",
            "type": "output",
            "kind": kind,
            "modified_at": modified_at,
            "size_bytes": resolved.stat().st_size,
        })
    artifacts.sort(key=lambda item: item["modified_at"], reverse=True)
    _output_artifact_cache = (now, artifacts)
    return artifacts[offset:offset + limit], len(artifacts)


def parse_outputs(history: dict[str, Any]) -> list[dict[str, Any]]:
    """從 history 解析輸出檔案清單。kind 依副檔名判斷（VHS 會把 mp4 存進 gifs key）。"""
    out: list[dict[str, Any]] = []
    for node_id, node_out in (history.get("outputs") or {}).items():
        if not isinstance(node_out, dict):
            continue
        for key, items in node_out.items():
            if key not in ("images", "gifs", "videos", "audio") or not isinstance(items, list):
                continue
            for item in items or []:
                if not isinstance(item, dict):
                    continue
                item = dict(item)
                fname = item.get("filename", "")
                ext = Path(fname).suffix.lower()
                item["kind"] = _KIND_BY_EXT.get(ext, key.rstrip("s"))
                item["node_id"] = str(node_id)
                out.append(item)
    return out


async def fetch_view(filename: str, subfolder: str = "", view_type: str = "output") -> tuple[bytes, str]:
    """代理 ComfyUI /view，回傳 (內容, content-type)。"""
    params = {"filename": filename, "subfolder": subfolder, "type": view_type}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(f"{COMFY_BASE}/view", params=params)
        r.raise_for_status()
        ctype = r.headers.get("content-type", "application/octet-stream")
        return r.content, ctype


async def upload_image(filename: str, data: bytes) -> dict[str, Any]:
    """上傳圖片到 ComfyUI input 目錄。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            f"{COMFY_BASE}/upload/image",
            files={"image": (filename, data)},
            data={"type": "input", "overwrite": "true"},
        )
        r.raise_for_status()
        return r.json()


async def cancel_prompt(prompt_id: str) -> None:
    """取消指定的排隊或執行中 prompt。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        queue = await client.get(f"{COMFY_BASE}/queue")
        queue.raise_for_status()
        payload = queue.json()
        pending = {
            str(item[1]) for item in payload.get("queue_pending", [])
            if isinstance(item, list) and len(item) > 1
        }
        if prompt_id in pending:
            response = await client.post(f"{COMFY_BASE}/queue", json={"delete": [prompt_id]})
        else:
            response = await client.post(f"{COMFY_BASE}/interrupt", json={"prompt_id": prompt_id})
        response.raise_for_status()


async def free_memory() -> None:
    """要求 ComfyUI 卸載模型並清理未使用顯存。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(
            f"{COMFY_BASE}/free",
            json={"unload_models": True, "free_memory": True},
        )
        response.raise_for_status()


def delete_output_file(output: dict[str, Any]) -> bool:
    """刪除受控 ComfyUI output/temp 檔案；所有路徑都做 containment 驗證。"""
    view_type = str(output.get("type") or "output")
    root = {"output": COMFY_OUTPUT_DIR, "temp": COMFY_TEMP_DIR}.get(view_type)
    if root is None:
        raise ValueError("只允許刪除 output 或 temp 作品")
    filename = str(output.get("filename") or "")
    subfolder = str(output.get("subfolder") or "")
    if not filename or Path(filename).name != filename:
        raise ValueError("無效的作品檔名")
    if Path(subfolder).is_absolute() or ".." in Path(subfolder).parts:
        raise ValueError("無效的作品路徑")
    resolved_root = root.resolve()
    target = (resolved_root / subfolder / filename).resolve()
    try:
        target.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError("作品路徑超出允許目錄") from exc
    if not target.is_file():
        return False
    target.unlink()
    global _output_artifact_cache
    _output_artifact_cache = None
    return True


def resolve_view_file(filename: str, subfolder: str = "", view_type: str = "output") -> Path:
    """Resolve a gallery media file while preventing path traversal."""
    root = {"output": COMFY_OUTPUT_DIR, "temp": COMFY_TEMP_DIR}.get(view_type)
    if root is None or not filename or Path(filename).name != filename:
        raise ValueError("無效的作品檔案")
    if Path(subfolder).is_absolute() or ".." in Path(subfolder).parts:
        raise ValueError("無效的作品路徑")
    resolved_root = root.resolve()
    target = (resolved_root / subfolder / filename).resolve()
    try:
        target.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError("作品路徑超出允許目錄") from exc
    if not target.is_file():
        raise FileNotFoundError(filename)
    return target


def get_video_thumbnail(filename: str, subfolder: str = "", view_type: str = "output") -> Path:
    """Create or reuse a small first-frame JPEG for a gallery video."""
    source = resolve_view_file(filename, subfolder, view_type)
    if _KIND_BY_EXT.get(source.suffix.lower()) not in {"video", "gif"}:
        raise ValueError("此作品沒有影片縮圖")
    stat = source.stat()
    cache_key = hashlib.sha256(
        f"{source}:{stat.st_mtime_ns}:{stat.st_size}".encode("utf-8")
    ).hexdigest()
    target = COMFY_THUMBNAIL_DIR / f"{cache_key}.jpg"
    if target.is_file():
        return target
    COMFY_THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp.jpg")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "0", "-i", str(source), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", str(temporary)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            check=True, timeout=15,
        )
        temporary.replace(target)
    except (OSError, subprocess.SubprocessError) as exc:
        temporary.unlink(missing_ok=True)
        raise RuntimeError("無法產生影片縮圖") from exc
    return target


# ── 永續 WebSocket + 事件分發 ────────────────────────────────────────────
#
# ComfyUI 的執行事件（executing / progress_state / executed / execution_success /
# execution_error）是 **unicast**：只發給提交 prompt 時 clientId 對應的 socket。
# 因此後端維護單一永續 WS 連線（固定 clientId），所有提交都用同一個 clientId，
# 收到的事件按 prompt_id 分發到 asyncio.Queue，SSE 端點再從佇列讀取。

_WS_CLIENT_ID = "ocs-backend"
_ws_task: asyncio.Task | None = None
_ws_ready = asyncio.Event()
_job_subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
_job_snapshots: dict[str, dict[str, Any]] = {}
_job_node_titles: dict[str, dict[str, str]] = {}


def ensure_ws() -> None:
    """確保永續 WS 連線任務在跑（冪等）。"""
    global _ws_task
    if _ws_task is None or _ws_task.done():
        _ws_task = asyncio.get_running_loop().create_task(_ws_loop())


async def _ws_loop() -> None:
    """永續連線 ComfyUI WS：事件按 prompt_id 分發到佇列，斷線自動重連。"""
    while True:
        try:
            uri = f"{WS_BASE}/ws?clientId={_WS_CLIENT_ID}"
            async with websockets.connect(uri, open_timeout=10.0, ping_interval=None, max_size=2**24) as ws:
                _ws_ready.set()
                logger.info("ComfyUI WS 已連線 (clientId=%s)", _WS_CLIENT_ID)
                async for raw in ws:
                    if isinstance(raw, (bytes, bytearray)):
                        continue  # 二進位預覽圖，跳過
                    try:
                        msg = json.loads(raw)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    _dispatch_event(msg)
        except asyncio.CancelledError:
            _ws_ready.clear()
            raise
        except Exception as e:
            _ws_ready.clear()
            logger.warning("ComfyUI WS 斷線: %s（5 秒後重連）", e)
            await asyncio.sleep(5)


def _dispatch_event(msg: dict[str, Any]) -> None:
    mtype = msg.get("type")
    data = msg.get("data") or {}
    pid = data.get("prompt_id")
    if not pid:
        return
    if mtype == "progress_state":
        # 0.31.0 新格式：所有節點進度聚合。
        # 只認 max>1 的真實工作節點，並優先顯示目前 running 的節點；
        # 切換階段時允許從 100% 回到新節點的 0%。
        best: tuple[float, float, float] | None = None
        nodes = list((data.get("nodes") or {}).values())
        running_nodes = [n for n in nodes if str(n.get("state", "")).lower() == "running"]
        for n in running_nodes or nodes:
            mx = n.get("max") or 0
            if mx <= 1:
                continue
            ratio = (n.get("value") or 0) / mx
            if best is None or mx > best[2] or (mx == best[2] and ratio > best[0]):
                best = (ratio, n.get("value") or 0, mx)
        if best:
            value, mx = best[1], best[2]
            node = str(next((n.get("node_id") for n in (running_nodes or nodes)
                             if (n.get("value") or 0) == value and (n.get("max") or 0) == mx), ""))
            _put_event(pid, _with_node_title(pid, {
                "event": "progress", "value": value, "max": mx, "node": node,
            }))
    elif mtype == "progress":
        value, mx = data.get("value") or 0, data.get("max") or 0
        if mx:
            _put_event(pid, _with_node_title(pid, {
                "event": "progress", "value": value, "max": mx,
                "node": str(data.get("node") or ""),
            }))
    elif mtype == "executing":
        _put_event(pid, _with_node_title(pid, {
            "event": "executing", "node": str(data.get("node") or ""),
        }))
    elif mtype == "execution_success":
        _put_event(pid, {"event": "done", "prompt_id": pid})
    elif mtype == "execution_interrupted":
        _put_event(pid, {"event": "error", "message": "任務被中斷", "prompt_id": pid})
    elif mtype == "execution_error":
        _put_event(
            pid,
            {
                "event": "error",
                "message": str(
                    data.get("exception_message")
                    or data.get("exception_type")
                    or data.get("node_type")
                    or "執行失敗"
                ),
                "prompt_id": pid,
            },
        )


def _with_node_title(pid: str, ev: dict[str, Any]) -> dict[str, Any]:
    node = str(ev.get("node") or "")
    if node:
        ev["node_title"] = _job_node_titles.get(pid, {}).get(node) or f"節點 {node}"
    return ev


def _put_event(pid: str, ev: dict[str, Any]) -> None:
    """保存最新快照，并广播给每个 SSE 订阅者；订阅者之间不会抢事件。"""
    if ev.get("event") in {"progress", "executing", "done", "error"}:
        _job_snapshots[pid] = dict(ev)
    for q in tuple(_job_subscribers.get(pid, ())):
        try:
            q.put_nowait(dict(ev))
        except asyncio.QueueFull:
            pass


def make_job_queue(prompt_id: str) -> None:
    """初始化任务通道；事件会先保存快照，因此 SSE 晚连接也不会丢状态。"""
    _job_subscribers.setdefault(prompt_id, set())


def get_progress_snapshot(prompt_id: str | None) -> dict[str, Any] | None:
    if not prompt_id:
        return None
    snapshot = _job_snapshots.get(prompt_id)
    return dict(snapshot) if snapshot else None


async def stream_progress(prompt_id: str, timeout: float = 10.0) -> AsyncIterator[dict[str, Any]]:
    """從事件佇列讀取指定 prompt 的進度事件。

    事件型別:
      {"event": "progress", "value": N, "max": M}
      {"event": "executing", "node": "12" | None}
      {"event": "done", "prompt_id": ...}
      {"event": "error", "message": ...}
    """
    ensure_ws()
    q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
    subscribers = _job_subscribers.setdefault(prompt_id, set())
    subscribers.add(q)
    snapshot = _job_snapshots.get(prompt_id)
    try:
        if snapshot:
            yield dict(snapshot)
        while True:
            try:
                ev = await asyncio.wait_for(q.get(), timeout=timeout)
            except asyncio.TimeoutError:
                # 心跳触发 history/queue 兜底检查，长节点不会被误判为失败。
                yield {"event": "heartbeat", "prompt_id": prompt_id}
                continue
            yield ev
            if ev["event"] in ("done", "error"):
                return
    finally:
        subscribers.discard(q)
        if not subscribers:
            _job_subscribers.pop(prompt_id, None)


# ── Job → Response 轉換 ──────────────────────────────────────────────────


def history_status(history: dict[str, Any]) -> tuple[str, str | None]:
    """從 history 判斷任務狀態：回傳 (status, error_message)。"""
    st = history.get("status") or {}
    if st.get("status_str") == "error":
        for m in st.get("messages", []) or []:
            if isinstance(m, list) and m and m[0] == "execution_error":
                d = m[1] or {}
                return "error", str(
                    d.get("exception_message") or d.get("exception_type") or "執行失敗"
                )
        return "error", "執行失敗"
    return "done", None


def job_to_response(job: Any) -> dict[str, Any]:
    live = get_progress_snapshot(job.prompt_id) or {}
    return {
        "id": job.id,
        "prompt_id": job.prompt_id,
        "workflow_id": job.workflow_id,
        "workflow_name": job.workflow_name,
        "params": json.loads(job.params_json or "{}"),
        "status": job.status,
        "progress": job.progress,
        "current_node": live.get("node"),
        "current_node_title": live.get("node_title"),
        "step_value": live.get("value"),
        "step_max": live.get("max"),
        "error": job.error,
        "outputs": json.loads(job.outputs_json or "[]"),
        "created_by": job.created_by,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
    }
