# ComfyUI 运维说明

## 服务信息

- 安装目录：`/home/wentao/project/ComfyUI`
- Python：`/home/wentao/project/ComfyUI/.venv/bin/python`
- 监听地址：`0.0.0.0:8188`
- 本机访问：`http://127.0.0.1:8188`
- Supervisor 服务名：`ocs-comfyui`
- 启动策略：按需启动，Supervisor 启动时不会自动拉起 ComfyUI
- Ops Control System 后端连接地址：`COMFYUI_BASE_URL`，默认 `http://127.0.0.1:8188`

## 日常操作

以下命令均在 `/home/wentao/project/ops-control-system` 目录执行：

```bash
# 启动
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf start ocs-comfyui

# 状态
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf status ocs-comfyui

# 重启
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-comfyui

# 停止
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf stop ocs-comfyui

# API 健康检查
curl -fsS http://127.0.0.1:8188/system_stats
```

配置文件发生变化后执行：

```bash
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf reread
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf update
```

## 日志与数据目录

- 标准输出：`supervisor/log/ocs-comfyui.log`
- 错误输出：`supervisor/log/ocs-comfyui-error.log`
- 输入：`/home/wentao/project/ComfyUI/input`
- 输出：`/home/wentao/project/ComfyUI/output`
- 临时文件：`/home/wentao/project/ComfyUI/temp`
- 工作流：`/home/wentao/project/ComfyUI/user/default/workflows`

查看实时日志：

```bash
tail -f supervisor/log/ocs-comfyui.log supervisor/log/ocs-comfyui-error.log
```

## GPU 注意事项

ComfyUI 与 Ollama 共用 GPU 0（NVIDIA GeForce RTX 3090，24 GiB）。ComfyUI Web 服务可以在显存紧张时启动，但生成任务可能因显存不足失败。执行大型工作流前先检查：

```bash
nvidia-smi
```

如果 Ollama 的 `llama-server` 占用了大部分显存，应先在确认没有其他推理任务后，通过 Ollama 的正常管理方式卸载模型或停止相关服务，再提交 ComfyUI 任务；不要直接强制终止不明 GPU 进程。

服务已使用 `--disable-async-offload --disable-smart-memory` 启动。这会让 MiniMax H3 在 24 GiB 显存上将模型权重更积极地卸载到内存，以避免 `VRAM grow failed`；代价是生成速度可能略慢。若日志再次出现该错误，先通过页面的“释放显存”操作或重启 `ocs-comfyui`，再重试任务。

## Ops Control System 集成

后端默认读取以下目录，无需额外配置：

```text
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_INPUT_DIR=/home/wentao/project/ComfyUI/input
COMFYUI_OUTPUT_DIR=/home/wentao/project/ComfyUI/output
COMFYUI_TEMP_DIR=/home/wentao/project/ComfyUI/temp
```

Ops Control System 的 ComfyUI 状态接口会通过 `/system_stats` 检查服务，并通过 ComfyUI WebSocket 接收任务进度。

## 启动记录

- 2026-08-10 10:56 JST：使用 ComfyUI 0.31.0、Python 3.12.3、PyTorch 2.12.0+cu130 在 GPU 0 启动；监听 `0.0.0.0:8188`。启动前 Ollama 一度占用约 23.7 GiB 显存，启动完成后该占用已释放；健康检查通过时 ComfyUI 仅占用约 256 MiB。此次仅确认 Web/API 正常，没有提交生成任务。
