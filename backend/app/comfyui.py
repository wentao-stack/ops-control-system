"""ComfyUI 整合模組 — 工作流模板化、參數注入、提交、進度串流。

對接本機 ComfyUI (預設 http://127.0.0.1:8188)：
- 模板: backend/app/comfyui_templates/*.api.json (API 格式工作流) + *.meta.json (參數映射)
- 提交: POST /prompt
- 進度: WebSocket /ws 轉成事件串流 (progress / executing / done / error)
- 輸出: /history 解析 + /view 代理預覽

環境變數:
- COMFYUI_BASE_URL (預設 http://127.0.0.1:8188)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
import websockets

logger = logging.getLogger(__name__)

COMFY_BASE = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip("/")
WS_BASE = COMFY_BASE.replace("http://", "ws://", 1)
TEMPLATES_DIR = Path(__file__).resolve().parent / "comfyui_templates"

_TIMEOUT = httpx.Timeout(60.0, connect=5.0)

# ── 模板載入 ──────────────────────────────────────────────────────────────


def list_templates() -> list[dict[str, Any]]:
    """掃描模板目錄，回傳 meta 列表（含內部 node 映射，schema 層會過濾）。"""
    out: list[dict[str, Any]] = []
    for meta_path in sorted(TEMPLATES_DIR.glob("*.meta.json")):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("模板 meta 解析失敗 %s: %s", meta_path.name, e)
            continue
        wf_path = TEMPLATES_DIR / meta.get("workflow", "")
        if not wf_path.exists():
            logger.warning("模板 %s 缺少工作流檔 %s", meta.get("id"), meta.get("workflow"))
            continue
        out.append(meta)
    return out


def get_template(template_id: str) -> dict[str, Any] | None:
    for t in list_templates():
        if t.get("id") == template_id:
            return t
    return None


def load_workflow(template: dict[str, Any]) -> dict[str, Any]:
    wf_path = TEMPLATES_DIR / template["workflow"]
    return json.loads(wf_path.read_text(encoding="utf-8"))


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
                node["inputs"][input_name] = value * tgt["multiply"]
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
        r.raise_for_status()
        prompt_id = r.json()["prompt_id"]
    make_job_queue(prompt_id)  # 提交後立刻建佇列，避免快任務事件遺失
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


_KIND_BY_EXT = {
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
    ".gif": "gif",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".wav": "audio", ".mp3": "audio", ".flac": "audio", ".aac": "audio", ".ogg": "audio",
}


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


# ── 永續 WebSocket + 事件分發 ────────────────────────────────────────────
#
# ComfyUI 的執行事件（executing / progress_state / executed / execution_success /
# execution_error）是 **unicast**：只發給提交 prompt 時 clientId 對應的 socket。
# 因此後端維護單一永續 WS 連線（固定 clientId），所有提交都用同一個 clientId，
# 收到的事件按 prompt_id 分發到 asyncio.Queue，SSE 端點再從佇列讀取。

_WS_CLIENT_ID = "ocs-backend"
_ws_task: asyncio.Task | None = None
_ws_ready = asyncio.Event()
_job_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}


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
        # 0.31.0 新格式：所有節點進度聚合。取完成比例最高的節點作為整體進度。
        best: tuple[float, float, float] | None = None
        for n in (data.get("nodes") or {}).values():
            mx = n.get("max") or 0
            if mx <= 0:
                continue
            ratio = (n.get("value") or 0) / mx
            if best is None or ratio > best[0]:
                best = (ratio, n.get("value") or 0, mx)
        if best:
            _put_event(pid, {"event": "progress", "value": best[1], "max": best[2]})
    elif mtype == "executing":
        _put_event(pid, {"event": "executing", "node": data.get("node")})
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


def _put_event(pid: str, ev: dict[str, Any]) -> None:
    q = _job_queues.get(pid)
    if q is None:
        return
    try:
        q.put_nowait(ev)
    except asyncio.QueueFull:
        pass


def make_job_queue(prompt_id: str) -> None:
    """在提交前先建立事件佇列，避免快任務的事件在 SSE 連上前遺失。"""
    _job_queues.setdefault(prompt_id, asyncio.Queue(maxsize=200))


async def stream_progress(prompt_id: str, timeout: float = 900.0) -> AsyncIterator[dict[str, Any]]:
    """從事件佇列讀取指定 prompt 的進度事件。

    事件型別:
      {"event": "progress", "value": N, "max": M}
      {"event": "executing", "node": "12" | None}
      {"event": "done", "prompt_id": ...}
      {"event": "error", "message": ...}
    """
    q = _job_queues.setdefault(prompt_id, asyncio.Queue(maxsize=200))
    try:
        while True:
            ev = await asyncio.wait_for(q.get(), timeout=timeout)
            yield ev
            if ev["event"] in ("done", "error"):
                return
    except asyncio.TimeoutError:
        yield {"event": "error", "message": "等待進度逾時（任務可能已中斷）"}
    finally:
        _job_queues.pop(prompt_id, None)


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
    return {
        "id": job.id,
        "prompt_id": job.prompt_id,
        "workflow_id": job.workflow_id,
        "workflow_name": job.workflow_name,
        "params": json.loads(job.params_json or "{}"),
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "outputs": json.loads(job.outputs_json or "[]"),
        "created_by": job.created_by,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
    }
