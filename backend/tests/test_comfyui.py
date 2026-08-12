from __future__ import annotations

import asyncio

import pytest

from app import comfyui


OBJECT_INFO = {
    "Source": {
        "display_name": "Source",
        "input": {"required": {"seed": ["INT", {"control_after_generate": True}]}},
        "input_order": {"required": ["seed"]},
    },
    "Target": {
        "display_name": "Target",
        "input": {
            "required": {
                "source": ["MODEL", {}],
                "prompt": ["STRING", {"multiline": True}],
                "enabled": ["BOOLEAN", {"default": True}],
            }
        },
        "input_order": {"required": ["source", "prompt", "enabled"]},
    },
}


def test_compile_ui_workflow_maps_links_widgets_and_seed_control():
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "Source",
                "mode": 0,
                "inputs": [{"name": "seed", "widget": {"name": "seed"}, "link": None}],
                "outputs": [{"name": "MODEL", "links": [1]}],
                "widgets_values": [42, "fixed"],
            },
            {
                "id": 2,
                "type": "Target",
                "mode": 0,
                "inputs": [
                    {"name": "source", "link": 1},
                    {"name": "prompt", "widget": {"name": "prompt"}, "link": None},
                    {"name": "enabled", "widget": {"name": "enabled"}, "link": None},
                ],
                "outputs": [],
                "widgets_values": ["hello", True],
            },
        ],
        "links": [[1, 1, 0, 2, 0, "MODEL"]],
    }

    prompt = comfyui.compile_ui_workflow(workflow, OBJECT_INFO)

    assert prompt["1"]["inputs"] == {"seed": 42}
    assert prompt["2"]["inputs"] == {
        "source": ["1", 0],
        "prompt": "hello",
        "enabled": True,
    }


def test_compile_ui_workflow_supports_named_v1_links():
    workflow = {
        "nodes": [
            {"id": 1, "type": "Source", "mode": 0, "inputs": [], "outputs": [{"name": "MODEL"}], "widgets_values": [7, "fixed"]},
            {
                "id": 2,
                "type": "Target",
                "mode": 0,
                "inputs": [{"name": "source", "link": 1}],
                "outputs": [],
                "widgets_values": ["prompt", False],
            },
        ],
        "links": [{"id": 1, "origin_id": 1, "origin_slot": "MODEL", "target_id": 2, "target_slot": "source", "type": "MODEL"}],
    }

    prompt = comfyui.compile_ui_workflow(workflow, OBJECT_INFO)

    assert prompt["2"]["inputs"]["source"] == ["1", 0]


def test_compile_ui_workflow_discards_disconnected_canvas_branches():
    object_info = {
        "Source": {"input": {"required": {}}, "input_order": {"required": []}},
        "SaveVideo": {
            "input": {"required": {"video": ["VIDEO", {}]}},
            "input_order": {"required": ["video"]},
        },
        "Unused": {"input": {"required": {}}, "input_order": {"required": []}},
    }
    workflow = {
        "nodes": [
            {"id": 1, "type": "Source", "mode": 0, "inputs": [], "outputs": [{"name": "VIDEO", "links": [1]}]},
            {"id": 2, "type": "SaveVideo", "mode": 0, "inputs": [{"name": "video", "link": 1}], "outputs": []},
            {"id": 3, "type": "Unused", "mode": 0, "inputs": [], "outputs": []},
        ],
        "links": [[1, 1, 0, 2, 0, "VIDEO"]],
    }

    prompt = comfyui.compile_ui_workflow(workflow, object_info)

    assert set(prompt) == {"1", "2"}


def test_normalize_workflow_selectors_removes_stale_model_directory():
    object_info = {
        "UNETLoader": {
            "input": {
                "required": {
                    "unet_name": [[
                        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                        "other-model.safetensors",
                    ], {}]
                }
            }
        }
    }
    prompt = {
        "214": {
            "class_type": "UNETLoader",
            "_meta": {"title": "H3 模型"},
            "inputs": {"unet_name": "Minimax_H3\\\\minimax_h3_fl2va_pruned_int8_convrot.safetensors"},
        }
    }

    adjusted, unavailable = comfyui.normalize_workflow_selectors(prompt, object_info)

    assert adjusted == ["H3 模型 · unet_name"]
    assert unavailable == []
    assert prompt["214"]["inputs"]["unet_name"] == "minimax_h3_fl2va_pruned_int8_convrot.safetensors"


def test_repair_unconnected_force_input_uses_unique_matching_output():
    object_info = {
        "ReferenceText": {"output": ["STRING", "TE_H3_REFERENCES"]},
        "Enhancer": {
            "input": {"required": {"references": ["TE_H3_REFERENCES", {"forceInput": True}]}},
        },
    }
    prompt = {
        "240": {"class_type": "ReferenceText", "inputs": {}},
        "253": {"class_type": "Enhancer", "inputs": {}, "_meta": {"title": "增强提示词"}},
    }

    repairs = comfyui.repair_unconnected_force_inputs(prompt, object_info)

    assert repairs == ["增强提示词 · references"]
    assert prompt["253"]["inputs"]["references"] == ["240", 1]


def test_compile_ui_workflow_rejects_subgraphs():
    with pytest.raises(ValueError, match="包含子圖"):
        comfyui.compile_ui_workflow({"nodes": [], "definitions": {"subgraphs": [{"id": "x"}]}}, OBJECT_INFO)


def test_compile_ui_workflow_executes_bypassed_nodes_and_skips_ui_only_nodes():
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "Source",
                "mode": 4,
                "inputs": [{"name": "seed", "widget": {"name": "seed"}, "link": None}],
                "outputs": [{"name": "MODEL", "links": [1]}],
                "widgets_values": [42, "fixed"],
            },
            {"id": 99, "type": "Label (rgthree)", "mode": 0, "inputs": [], "outputs": []},
            {
                "id": 2,
                "type": "Target",
                "mode": 4,
                "inputs": [
                    {"name": "source", "link": 1},
                    {"name": "prompt", "widget": {"name": "prompt"}, "link": None},
                    {"name": "enabled", "widget": {"name": "enabled"}, "link": None},
                ],
                "outputs": [],
                "widgets_values": ["hello", True],
            },
        ],
        "links": [[1, 1, 0, 2, 0, "MODEL"]],
    }

    prompt = comfyui.compile_ui_workflow(workflow, OBJECT_INFO)

    assert set(prompt) == {"1", "2"}
    assert prompt["2"]["inputs"]["source"] == ["1", 0]


@pytest.mark.parametrize(
    ("node_class", "raw_length", "frame_min", "frame_step", "fps", "expected_frames"),
    [
        ("MiniMaxH3AudioConditioningT8", 124, 5, 17, 24, 124),
        ("LTXVImgToVideo", 121, 9, 8, 24, 121),
        ("WanVaceToVideo", 81, 1, 4, 16, 81),
    ],
)
def test_length_is_exposed_as_seconds_and_converted_to_model_frames(
    node_class, raw_length, frame_min, frame_step, fps, expected_frames
):
    object_info = {
        node_class: {
            "display_name": node_class,
            "input": {
                "required": {
                    "length": ["INT", {"min": frame_min, "max": 3600, "step": frame_step}],
                }
            },
        },
        "CreateVideo": {
            "display_name": "Create Video",
            "input": {"required": {"fps": ["FLOAT", {"min": 1, "max": 120, "step": 1}]}},
        },
    }
    prompt = {
        "6": {"class_type": node_class, "inputs": {"length": raw_length}},
        "12": {"class_type": "CreateVideo", "inputs": {"fps": fps}},
    }

    params = comfyui._extract_params(prompt, object_info)
    duration = next(param for param in params if param["key"] == "duration_seconds")

    assert duration["label"] == "生成时间长度"
    assert duration["default"] == 5
    assert duration["unit"] == "秒"
    assert not any(param["key"].endswith(":length") for param in params)

    template = {"params": params}
    workflow = {key: {**node, "inputs": dict(node["inputs"])} for key, node in prompt.items()}
    comfyui.inject_params(workflow, template, {"duration_seconds": 5})
    assert workflow["6"]["inputs"]["length"] == expected_frames


def test_duplicate_length_inputs_are_merged_and_updated_together():
    object_info = {
        "LengthNode": {
            "display_name": "Length Node",
            "input": {"required": {"length": ["INT", {"min": 1, "max": 16384, "step": 8}]}},
        },
        "CreateVideo": {
            "display_name": "Create Video",
            "input": {"required": {"fps": ["FLOAT", {"min": 1, "max": 120, "step": 1}]}},
        },
    }
    prompt = {
        "7": {"class_type": "LengthNode", "inputs": {"length": 121}},
        "8": {"class_type": "LengthNode", "inputs": {"length": 121}},
        "17": {"class_type": "CreateVideo", "inputs": {"fps": 24}},
    }

    params = comfyui._extract_params(prompt, object_info)
    duration = next(param for param in params if param["key"] == "duration_seconds")
    assert len(duration["targets"]) == 2

    workflow = {key: {**node, "inputs": dict(node["inputs"])} for key, node in prompt.items()}
    comfyui.inject_params(workflow, {"params": params}, {"duration_seconds": 5})
    assert workflow["7"]["inputs"]["length"] == 121
    assert workflow["8"]["inputs"]["length"] == 121


def test_delete_output_file_is_contained(tmp_path, monkeypatch):
    output_dir = tmp_path / "output"
    target = output_dir / "clips" / "result.mp4"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"video")
    monkeypatch.setattr(comfyui, "COMFY_OUTPUT_DIR", output_dir)

    assert comfyui.delete_output_file({"filename": "result.mp4", "subfolder": "clips", "type": "output"})
    assert not target.exists()
    with pytest.raises(ValueError, match="無效的作品路徑"):
        comfyui.delete_output_file({"filename": "secret", "subfolder": "../", "type": "output"})


def test_list_output_artifacts_discovers_console_outputs(tmp_path, monkeypatch):
    output_dir = tmp_path / "output"
    video = output_dir / "console" / "result.mp4"
    image = output_dir / "image.png"
    ignored = output_dir / "metadata.json"
    video.parent.mkdir(parents=True)
    video.write_bytes(b"video")
    image.write_bytes(b"image")
    ignored.write_text("{}")
    monkeypatch.setattr(comfyui, "COMFY_OUTPUT_DIR", output_dir)

    artifacts, total = comfyui.list_output_artifacts()

    assert total == 2
    assert {(item["filename"], item["subfolder"], item["kind"]) for item in artifacts} == {
        ("result.mp4", "console", "video"),
        ("image.png", "", "image"),
    }

    page, total = comfyui.list_output_artifacts(offset=1, limit=1)
    assert total == 2
    assert len(page) == 1


def test_progress_state_prefers_current_running_node_and_reports_exact_steps(monkeypatch):
    pid = "prompt-running"
    monkeypatch.setitem(comfyui._job_node_titles, pid, {"7": "H3 Sampler"})
    comfyui._job_snapshots.pop(pid, None)
    comfyui._dispatch_event({
        "type": "progress_state",
        "data": {"prompt_id": pid, "nodes": {
            "6": {"node_id": "6", "state": "finished", "value": 243, "max": 243},
            "7": {"node_id": "7", "state": "running", "value": 5, "max": 10},
        }},
    })
    assert comfyui.get_progress_snapshot(pid) == {
        "event": "progress", "value": 5, "max": 10,
        "node": "7", "node_title": "H3 Sampler",
    }


def test_legacy_progress_event_is_supported(monkeypatch):
    pid = "prompt-legacy"
    monkeypatch.setitem(comfyui._job_node_titles, pid, {"10": "Sampler"})
    comfyui._job_snapshots.pop(pid, None)
    comfyui._dispatch_event({
        "type": "progress",
        "data": {"prompt_id": pid, "node": "10", "value": 3, "max": 4},
    })
    snapshot = comfyui.get_progress_snapshot(pid)
    assert snapshot is not None
    assert (snapshot["value"], snapshot["max"], snapshot["node_title"]) == (3, 4, "Sampler")


@pytest.mark.asyncio
async def test_progress_stream_replays_snapshot_and_broadcasts_to_all_subscribers(monkeypatch):
    pid = "prompt-broadcast"
    monkeypatch.setattr(comfyui, "ensure_ws", lambda: None)
    comfyui._job_snapshots.pop(pid, None)
    comfyui._job_subscribers.pop(pid, None)
    first = comfyui.stream_progress(pid, timeout=1)
    second = comfyui.stream_progress(pid, timeout=1)
    first_wait = asyncio.create_task(anext(first))
    second_wait = asyncio.create_task(anext(second))
    await asyncio.sleep(0)
    event = {"event": "progress", "value": 2, "max": 5, "node": "7"}
    comfyui._put_event(pid, event)
    assert await first_wait == event
    assert await second_wait == event
    await first.aclose()
    await second.aclose()
    replay = comfyui.stream_progress(pid, timeout=1)
    assert await anext(replay) == event
    await replay.aclose()
