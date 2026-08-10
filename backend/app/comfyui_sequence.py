from __future__ import annotations

import asyncio
import json
import math
import os
import random
import re
import shutil
import tempfile
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from . import comfyui
from .comfyui_sequence_models import ComfySequence
from .database import SessionLocal


COMFY_INPUT_DIR = Path(os.environ.get("COMFYUI_INPUT_DIR", "/home/wentao/project/ComfyUI/input"))
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFYUI_OUTPUT_DIR", "/home/wentao/project/ComfyUI/output"))
WORKFLOW_FILENAME = "H3_Turbo_Stable_4V4A_I2V.json"
FPS = 24
_tasks: dict[str, asyncio.Task[None]] = {}

_TIME_TOKEN = r"(?:\d{1,3}:\d{1,2}(?:\.\d+)?|\d+(?:\.\d+)?)"
_RANGE_RE = re.compile(
    rf"^\s*[\[【(（]?\s*(?P<start>{_TIME_TOKEN})\s*(?:s|秒)?\s*"
    rf"(?:-|~|～|—|–|至|到)\s*(?P<end>{_TIME_TOKEN})\s*(?:s|秒)?\s*"
    rf"[\]】)）]?\s*(?:[:：]\s*)?(?P<text>.+?)\s*$",
    re.IGNORECASE,
)
_POINT_RE = re.compile(
    rf"^\s*[\[【(（]?\s*(?P<start>{_TIME_TOKEN})\s*(?:s|秒)?\s*"
    rf"[\]】)）]?\s*[:：]\s*(?P<text>.+?)\s*$",
    re.IGNORECASE,
)


class SequenceCancelled(Exception):
    pass


def _time_seconds(value: str) -> float:
    if ":" not in value:
        return float(value)
    minutes, seconds = value.split(":", 1)
    return float(minutes) * 60 + float(seconds)


def parse_timed_prompt(prompt: str, total_seconds: int) -> tuple[list[str], list[dict[str, Any]]]:
    """Parse timeline lines, returning global instructions and normalized cues.

    Supported examples: ``0-5秒：...``, ``5s-10s: ...``, and
    ``00:10-00:15 ...``. A point marker such as ``10秒：...`` lasts until
    the next point marker or the end of the requested video.
    """
    global_lines: list[str] = []
    ranges: list[dict[str, Any]] = []
    points: list[dict[str, Any]] = []
    for raw_line in prompt.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = _RANGE_RE.match(line)
        if match:
            start = _time_seconds(match.group("start"))
            end = _time_seconds(match.group("end"))
            if end > start and start < total_seconds:
                ranges.append({
                    "start": max(0.0, start),
                    "end": min(float(total_seconds), end),
                    "text": match.group("text").strip(),
                })
            continue
        match = _POINT_RE.match(line)
        if match:
            start = _time_seconds(match.group("start"))
            if start < total_seconds:
                points.append({"start": max(0.0, start), "text": match.group("text").strip()})
            continue
        global_lines.append(line)

    points.sort(key=lambda cue: cue["start"])
    for index, cue in enumerate(points):
        end = points[index + 1]["start"] if index + 1 < len(points) else float(total_seconds)
        if end > cue["start"]:
            ranges.append({**cue, "end": end})
    ranges.sort(key=lambda cue: (cue["start"], cue["end"]))
    return global_lines, ranges


def prompt_for_segment(
    global_lines: list[str],
    cues: list[dict[str, Any]],
    segment_start: int,
    segment_end: int,
) -> str:
    """Translate absolute timeline cues into local times for one clip."""
    parts: list[str] = []
    if global_lines:
        parts.append("Requirements for the whole video: " + " ".join(global_lines))
    local_cues: list[str] = []
    for cue in cues:
        overlap_start = max(float(segment_start), float(cue["start"]))
        overlap_end = min(float(segment_end), float(cue["end"]))
        if overlap_end <= overlap_start:
            continue
        local_start = overlap_start - segment_start
        local_end = overlap_end - segment_start
        local_cues.append(f"From {local_start:g}s to {local_end:g}s: {cue['text']}")
    if local_cues:
        parts.append("Timed actions inside this segment: " + "; ".join(local_cues))
    if not parts:
        parts.append("Continue the previous action naturally with smooth, coherent motion.")
    return " ".join(parts)


def align_h3_frames(seconds: int) -> int:
    """H3 accepts 17n+5 frame counts, in the trained range 124..362."""
    raw = round(seconds * FPS)
    aligned = raw + ((5 - raw) % 17)
    return max(124, min(362, aligned))


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _contained(root: Path, path: Path) -> Path:
    resolved_root = root.resolve()
    resolved = path.resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise RuntimeError("檔案路徑超出 ComfyUI 目錄")
    return resolved


def _output_path(item: dict[str, Any]) -> Path:
    return _contained(
        COMFY_OUTPUT_DIR,
        COMFY_OUTPUT_DIR / str(item.get("subfolder", "")) / str(item["filename"]),
    )


def _is_cancelled(sequence_id: str) -> bool:
    with SessionLocal() as session:
        sequence = session.get(ComfySequence, sequence_id)
        return sequence is None or sequence.status == "cancelled"


def _update(sequence_id: str, **values: Any) -> None:
    with SessionLocal() as session:
        sequence = session.get(ComfySequence, sequence_id)
        if sequence is None:
            return
        for key, value in values.items():
            setattr(sequence, key, value)
        sequence.updated_at = _utcnow()
        session.commit()


async def _workflow_prompt() -> dict[str, Any]:
    workflows = await comfyui.list_workflows()
    template = next((item for item in workflows if item.get("filename") == WORKFLOW_FILENAME), None)
    if template is None:
        raise RuntimeError(f"找不到工作流 {WORKFLOW_FILENAME}")
    if not template.get("runnable", False):
        raise RuntimeError(template.get("disabled_reason") or "工作流目前無法執行")
    return deepcopy(template["workflow"])


def build_segment_prompt(
    base_prompt: dict[str, Any],
    *,
    sequence_id: str,
    segment_index: int,
    motion_prompt: str,
    first_frame: str,
    character_ref: str,
    background_ref: str,
    width: int,
    height: int,
    seconds: int,
    seed: int,
) -> tuple[dict[str, Any], int]:
    prompt = deepcopy(base_prompt)
    frames = align_h3_frames(seconds)

    prompt["13"]["inputs"]["image"] = first_frame
    prompt["14"] = {
        "class_type": "LoadImage",
        "inputs": {"image": character_ref},
        "_meta": {"title": "人物參考圖"},
    }
    prompt["15"] = {
        "class_type": "LoadImage",
        "inputs": {"image": background_ref},
        "_meta": {"title": "背景參考圖"},
    }

    conditioning = prompt["6"]["inputs"]
    conditioning.update({
        "prompt": (
            "<Picture 1> is the exact temporal starting frame. "
            "Keep the same character identity, face, hair, clothes and body proportions from <Picture 2>. "
            "Keep the same environment, layout, lighting and visual style from <Picture 3>. "
            "Continue naturally from the previous frame with smooth motion; no cuts, scene changes, "
            "new characters, identity drift, costume changes, camera teleporting, text or logos. "
            f"Action for this segment: {motion_prompt}"
        ),
        "width": width,
        "height": height,
        "length": frames,
        "task_type": "Hybrid",
        "strict_prompt_tags": True,
        # ComfyUI V3 Autogrow inputs must use dotted dynamic paths. They are
        # nested into execute(ref_images={...}) before the node is called.
        "ref_images.ref_image_0": ["14", 0],
        "ref_images.ref_image_1": ["15", 0],
    })
    prompt["9"]["inputs"]["noise_seed"] = seed
    prompt["12"]["inputs"]["filename_prefix"] = f"sequences/{sequence_id}/segment_{segment_index:03d}"
    return prompt, frames


async def _run_command(*args: str) -> None:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode:
        message = stderr.decode("utf-8", errors="replace")[-2000:]
        raise RuntimeError(f"FFmpeg 執行失敗：{message}")


async def _extract_last_frame(video_path: Path, sequence_id: str, index: int) -> str:
    relative = Path("sequence_chain") / sequence_id / f"last_{index:03d}.png"
    target = _contained(COMFY_INPUT_DIR, COMFY_INPUT_DIR / relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    await _run_command(
        "ffmpeg", "-y", "-sseof", "-1", "-i", str(video_path),
        "-vf", "reverse", "-frames:v", "1", str(target),
    )
    return relative.as_posix()


async def _wait_for_output(sequence_id: str, prompt_id: str) -> dict[str, Any]:
    while True:
        if _is_cancelled(sequence_id):
            raise SequenceCancelled()
        history = await comfyui.get_history(prompt_id)
        if history:
            state, error = comfyui.history_status(history)
            if state == "error":
                raise RuntimeError(error or "ComfyUI 生成失敗")
            if state == "done":
                outputs = comfyui.parse_outputs(history)
                video = next((item for item in outputs if item.get("kind") == "video"), None)
                if video is None:
                    raise RuntimeError("工作流已完成，但沒有找到影片輸出")
                return video
        await asyncio.sleep(3)


async def _concat_segments(paths: list[Path], target: Path, total_seconds: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    list_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
            list_path = Path(handle.name)
            for path in paths:
                escaped = str(path).replace("'", "'\\''")
                handle.write(f"file '{escaped}'\n")
        try:
            await _run_command(
                "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_path),
                "-t", str(total_seconds), "-c", "copy", "-movflags", "+faststart", str(target),
            )
        except RuntimeError:
            await _run_command(
                "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_path),
                "-t", str(total_seconds), "-c:v", "libx264", "-preset", "medium", "-crf", "19",
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(target),
            )
    finally:
        if list_path is not None:
            list_path.unlink(missing_ok=True)


async def _run_sequence(sequence_id: str) -> None:
    try:
        with SessionLocal() as session:
            sequence = session.get(ComfySequence, sequence_id)
            if sequence is None:
                return
            config = {
                "prompt": sequence.prompt,
                "first_frame": sequence.first_frame,
                "character_ref": sequence.character_ref,
                "background_ref": sequence.background_ref,
                "width": sequence.width,
                "height": sequence.height,
                "segment_seconds": sequence.segment_seconds,
                "total_seconds": sequence.total_seconds,
                "seed": sequence.seed,
                "total_segments": sequence.total_segments,
            }

        base_prompt = await _workflow_prompt()
        global_prompt, timed_cues = parse_timed_prompt(str(config["prompt"]), int(config["total_seconds"]))
        current_frame = str(config["first_frame"])
        remaining = int(config["total_seconds"])
        segments: list[dict[str, Any]] = []
        video_paths: list[Path] = []
        base_seed = int(config["seed"])
        if base_seed < 0:
            base_seed = random.SystemRandom().randint(0, 2**63 - 1000)

        for index in range(1, int(config["total_segments"]) + 1):
            if _is_cancelled(sequence_id):
                raise SequenceCancelled()
            requested_seconds = min(int(config["segment_seconds"]), remaining)
            segment_start = (index - 1) * int(config["segment_seconds"])
            segment_end = min(segment_start + requested_seconds, int(config["total_seconds"]))
            distributed_prompt = prompt_for_segment(global_prompt, timed_cues, segment_start, segment_end)
            prompt, frames = build_segment_prompt(
                base_prompt,
                sequence_id=sequence_id,
                segment_index=index,
                motion_prompt=distributed_prompt,
                first_frame=current_frame,
                character_ref=str(config["character_ref"]),
                background_ref=str(config["background_ref"]),
                width=int(config["width"]),
                height=int(config["height"]),
                seconds=requested_seconds,
                # Every chained segment shares one seed. The changing first frame
                # supplies temporal evolution while a stable seed reduces identity,
                # composition and motion drift between clips.
                seed=base_seed,
            )
            prompt_id = await comfyui.submit_workflow(prompt)
            _update(
                sequence_id,
                status="running",
                current_segment=index,
                current_prompt_id=prompt_id,
                progress=round((index - 1) / int(config["total_segments"]) * 90),
            )
            output = await _wait_for_output(sequence_id, prompt_id)
            video_path = _output_path(output)
            if not video_path.is_file():
                raise RuntimeError(f"找不到分段影片：{video_path.name}")
            current_frame = await _extract_last_frame(video_path, sequence_id, index)
            segment = {
                "index": index,
                "prompt_id": prompt_id,
                "requested_seconds": requested_seconds,
                "frames": frames,
                "output": output,
                "last_frame": current_frame,
            }
            segments.append(segment)
            video_paths.append(video_path)
            remaining -= requested_seconds
            _update(
                sequence_id,
                segments_json=json.dumps(segments, ensure_ascii=False),
                progress=round(index / int(config["total_segments"]) * 90),
            )

        if _is_cancelled(sequence_id):
            raise SequenceCancelled()
        _update(sequence_id, status="stitching", progress=95, current_prompt_id=None)
        final_subfolder = Path("sequences") / sequence_id
        final_path = _contained(COMFY_OUTPUT_DIR, COMFY_OUTPUT_DIR / final_subfolder / "final.mp4")
        await _concat_segments(video_paths, final_path, int(config["total_seconds"]))
        if _is_cancelled(sequence_id):
            raise SequenceCancelled()
        final_output = {
            "filename": "final.mp4",
            "subfolder": final_subfolder.as_posix(),
            "type": "output",
            "kind": "video",
        }
        _update(
            sequence_id,
            status="done",
            progress=100,
            final_output_json=json.dumps(final_output, ensure_ascii=False),
            current_prompt_id=None,
            finished_at=_utcnow(),
        )
    except SequenceCancelled:
        _update(sequence_id, status="cancelled", current_prompt_id=None, finished_at=_utcnow())
    except Exception as exc:
        _update(
            sequence_id,
            status="error",
            error=str(exc),
            current_prompt_id=None,
            finished_at=_utcnow(),
        )


def start_sequence(sequence_id: str) -> None:
    current = _tasks.get(sequence_id)
    if current is not None and not current.done():
        return
    task = asyncio.create_task(_run_sequence(sequence_id))
    _tasks[sequence_id] = task
    task.add_done_callback(lambda _: _tasks.pop(sequence_id, None))


async def cancel_sequence(sequence_id: str) -> None:
    with SessionLocal() as session:
        sequence = session.get(ComfySequence, sequence_id)
        if sequence is None:
            raise KeyError(sequence_id)
        prompt_id = sequence.current_prompt_id
        sequence.status = "cancelled"
        sequence.updated_at = _utcnow()
        sequence.finished_at = _utcnow()
        session.commit()
    if prompt_id:
        await comfyui.cancel_prompt(prompt_id)


def delete_sequence_files(sequence_id: str) -> None:
    for root, relative in (
        (COMFY_OUTPUT_DIR, Path("sequences") / sequence_id),
        (COMFY_INPUT_DIR, Path("sequence_chain") / sequence_id),
    ):
        target = _contained(root, root / relative)
        if target.is_dir():
            shutil.rmtree(target)


def segment_count(total_seconds: int, segment_seconds: int) -> int:
    return math.ceil(total_seconds / segment_seconds)
