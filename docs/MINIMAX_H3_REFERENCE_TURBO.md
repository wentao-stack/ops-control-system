# MiniMax H3 Reference + Turbo Stable 4V4A I2V

## 结论

官方 Reference-to-Video 工作流与现有 Turbo Stable 4V4A I2V 不能直接替换 conditioning 节点：官方 R2V 使用独立的 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`，现有 Turbo I2V 使用 `minimax_h3_fl2va_int8_convrot.safetensors` 与四步 Turbo LoRA。

本项目采用兼容改造：保留 FL2VA、Turbo 四步 LoRA、4V/4A 双时钟采样和精确 I2V 首帧，通过本机 `MiniMaxH3AudioConditioningT8` 的 Hybrid 路径加入官方格式的多参考图 conditioning。

## 工作流结构

```text
Picture 1（精确首帧） ─┐
Picture 2（主体身份） ──┼─> H3 Hybrid Conditioning ─> Stable 4V/4A ─> AV Decode ─> MP4
Picture 3（场景风格） ──┘              ↑
FL2VA + Turbo 4-step LoRA ─────────────┘
```

参数与标签映射：

| 输入 | 提示词标签 | 用途 |
|---|---|---|
| Picture 1 | `<Picture 1>` | 精确锁定第 0 帧，保留 I2V 构图 |
| Picture 2 | `<Picture 2>` | 人物身份、脸、服装、材质参考 |
| Picture 3 | `<Picture 3>` | 场景、光线、色彩和视觉风格参考 |

提示词标签按连接顺序编号。启用了 `strict_prompt_tags`，引用未连接的 `<Picture N>` 会在执行前报错，避免静默错配。

## 相对官方模板的改进

- 保留首帧硬约束，同时加入两张软参考图，适合“指定开场构图 + 保人物 + 保场景风格”的任务。
- 使用 Turbo LoRA 与 Stable 4V/4A 双时钟采样，视频和原生音频均为 4 步。
- 默认 `864 × 480`、124 帧、24 FPS，降低 RTX 3090 24 GB 上多参考 token 带来的显存和耗时压力。
- 默认 `ref_image_size=match`。只有身份漂移明显且显存允许时才改为 `max`；`max` 会让参考 token 在每个采样步保持更大尺寸，速度明显下降。
- 默认原生环境音，无外部音频依赖；需要对白或锁定音轨时，再扩展 `drive_audio`。
- API 工作流直接供 Ops Control System 动态发现，不依赖 ComfyUI 子图编译。

## 推荐设置

| 场景 | 分辨率 | 时长 | 参考尺寸 | 说明 |
|---|---:|---:|---|---|
| 快速预览 | 864×480 | 5 秒 | match | 默认，先检查标签和主体一致性 |
| 成片平衡 | 1056×608 | 5–10 秒 | match | 质量与 24 GB 显存较均衡 |
| 身份优先 | 864×480 | 5 秒 | max | 更强参考保真，耗时和显存明显增加 |

H3 帧数会按 24 FPS 自动向上对齐到 `17n+5`。5 秒对应 124 帧，实际约 5.17 秒。建议先用固定种子调整提示词，再随机种子扩展候选结果。

## 文件位置

- 项目内版本：`backend/app/comfyui_templates/h3_turbo_stable_4v4a_reference_i2v.api.json`
- ComfyUI 运行版本：`user/default/workflows/H3_Turbo_Stable_4V4A_Reference_I2V.api.json`
- 输出目录：`ComfyUI/output/MiniMaxH3/`

## 官方参考

- [ComfyUI 官方 MiniMax H3 Reference-to-Video 模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_r2v.json)
- [ComfyUI 官方 MiniMax H3 Image-to-Video 模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_i2v.json)
- [Comfy-Org MiniMax-H3 模型仓库](https://huggingface.co/Comfy-Org/MiniMax-H3)

官方 R2V 的独立 Ref2VA 权重通常仍是纯参考图保真任务的首选；本改造版优先解决 I2V 精确首帧、参考一致性和四步生成速度的组合需求。
