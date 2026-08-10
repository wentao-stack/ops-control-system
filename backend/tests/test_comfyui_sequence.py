from __future__ import annotations

from app.comfyui_sequence import (
    align_h3_frames,
    build_segment_prompt,
    parse_timed_prompt,
    prompt_for_segment,
    segment_count,
)


def _base_prompt():
    return {
        "6": {"class_type": "Conditioning", "inputs": {"prompt": "", "task_type": "I2VA"}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": 1}},
        "12": {"class_type": "VideoCombine", "inputs": {"filename_prefix": "old"}},
        "13": {"class_type": "LoadImage", "inputs": {"image": "old.png"}},
    }


def test_align_h3_frames_uses_17n_plus_5_range():
    assert align_h3_frames(5) == 124
    assert align_h3_frames(10) == 243
    assert align_h3_frames(15) == 362
    assert all(value % 17 == 5 for value in (align_h3_frames(5), align_h3_frames(10), align_h3_frames(15)))


def test_segment_count_includes_short_tail():
    assert segment_count(30, 10) == 3
    assert segment_count(31, 10) == 4


def test_build_segment_prompt_maps_temporal_character_and_background_refs():
    prompt, frames = build_segment_prompt(
        _base_prompt(),
        sequence_id="seq-test",
        segment_index=2,
        motion_prompt="walk slowly",
        first_frame="chain/last.png",
        character_ref="person.png",
        background_ref="room.png",
        width=864,
        height=480,
        seconds=10,
        seed=99,
    )

    assert frames == 243
    assert prompt["13"]["inputs"]["image"] == "chain/last.png"
    assert prompt["14"]["inputs"]["image"] == "person.png"
    assert prompt["15"]["inputs"]["image"] == "room.png"
    assert prompt["6"]["inputs"]["task_type"] == "Hybrid"
    assert "ref_image_1" not in prompt["6"]["inputs"]
    assert "ref_image_2" not in prompt["6"]["inputs"]
    assert prompt["6"]["inputs"]["ref_images.ref_image_0"] == ["14", 0]
    assert prompt["6"]["inputs"]["ref_images.ref_image_1"] == ["15", 0]
    assert prompt["9"]["inputs"]["noise_seed"] == 99
    assert "<Picture 1>" in prompt["6"]["inputs"]["prompt"]
    assert "<Picture 2>" in prompt["6"]["inputs"]["prompt"]
    assert "<Picture 3>" in prompt["6"]["inputs"]["prompt"]
    assert prompt["12"]["inputs"]["filename_prefix"] == "sequences/seq-test/segment_002"


def test_timed_prompt_is_distributed_and_rebased_per_segment():
    global_lines, cues = parse_timed_prompt(
        "全程保持鏡頭平穩\n0-5秒：人物起身\n5s-12s: 走向窗邊\n00:12-00:20：轉身微笑",
        20,
    )

    first = prompt_for_segment(global_lines, cues, 0, 10)
    second = prompt_for_segment(global_lines, cues, 10, 20)

    assert "Requirements for the whole video: 全程保持鏡頭平穩" in first
    assert "From 0s to 5s: 人物起身" in first
    assert "From 5s to 10s: 走向窗邊" in first
    assert "From 0s to 2s: 走向窗邊" in second
    assert "From 2s to 10s: 轉身微笑" in second


def test_point_markers_last_until_next_marker():
    _, cues = parse_timed_prompt("0秒：站立\n5秒：開始行走\n10秒：停下", 15)
    assert [(cue["start"], cue["end"]) for cue in cues] == [(0, 5), (5, 10), (10, 15)]
