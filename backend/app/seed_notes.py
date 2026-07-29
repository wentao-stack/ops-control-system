#!/usr/bin/env python3
"""Seed knowledge base notes into SQLite database."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

from app.database import SessionLocal
from app.models import Note

NOTES = [
    # ── 筆記 ──────────────────────────────────────────────────────────────
    {
        "title": "SSH Web Terminal 宽度问题排错记录",
        "category": "筆記",
        "content": (
            "## 问题\n"
            "SSH 终端输出被截断，ls 只有 2 列就换行。\n\n"
            "## 排查过程\n"
            "1. 前端 fit() 执行时机不对 -> 改用 requestAnimationFrame\n"
            "2. term.on() 不是 xterm 5.x API -> 改用 onResize\n"
            "3. term_size=(rows, cols) 传反了 -> asyncssh 期望 (width, height) 即 (cols, rows)\n\n"
            "## 根因\n"
            "asyncssh 的 term_size 参数是 (width, height)，但我们传了 (rows, cols)。\n"
            "例如 142 列 24 行，传成了 (24, 142)，SSH 服务器以为宽度只有 24 列。\n\n"
            "## 修复\n"
            "- backend/app/webssh.py: term_size=(rows, cols) -> term_size=(cols, rows)\n"
            "- frontend/src/components/WebTerminal.tsx: term.on() -> term.onResize()\n"
            "- 线上访问走 frontend/dist，改完必须 npm run build"
        ),
        "tags": ["ssh", "xterm", "asyncssh", "排错"],
    },
    {
        "title": "FRP + Nginx 反代架构",
        "category": "筆記",
        "content": (
            "## 架构\n"
            "```\n"
            "浏览器 -> ops.sanbunto.online:443\n"
            "  -> Nginx (163.44.124.142)\n"
            "    -> FRP TCP :7000\n"
            "      -> 本地 frpc\n"
            "        -> 本地 :8000 (后端)\n"
            "```\n\n"
            "## 域名映射\n"
            "- comfy.sanbunto.online -> ComfyUI\n"
            "- nexus.sanbunto.online -> Nexus Repository\n"
            "- llama.sanbunto.online -> Ollama\n"
            "- audio.sanbunto.online -> Speech-to-Speech\n"
            "- ops.sanbunto.online -> 运维系统\n\n"
            "## 注意\n"
            "- Nginx 没有编译 stream 模块\n"
            "- FRP dashboard 在 :7500\n"
            "- Vite dev server :5173 不暴露到线上"
        ),
        "tags": ["frp", "nginx", "反代", "架构"],
    },
    {
        "title": "Supervisor 进程管理",
        "category": "筆記",
        "content": (
            "## 配置\n"
            "deploy/supervisor.conf\n\n"
            "## 管理命令\n"
            "```bash\n"
            "supervisorctl -c deploy/supervisor.conf status\n"
            "supervisorctl -c deploy/supervisor.conf restart ops-control-backend\n"
            "supervisorctl -c deploy/supervisor.conf restart ops-control-frontend\n"
            "```\n\n"
            "## 服务\n"
            "- ops-control-backend: uvicorn, :8000\n"
            "- ops-control-frontend: vite, :5173\n\n"
            "## 日志\n"
            "- logs/backend.log (maxbytes=50MB)\n"
            "- logs/frontend.log (maxbytes=50MB)\n"
            "- logs/supervisord.log"
        ),
        "tags": ["supervisor", "进程管理", "部署"],
    },
    # ── 知識 ──────────────────────────────────────────────────────────────
    {
        "title": "Vultr API v2 使用指南",
        "category": "知識",
        "content": (
            "## Base URL\n"
            "https://api.vultr.com/v2\n\n"
            "## 认证\n"
            "Authorization: Bearer <API_KEY>\n\n"
            "## 主要端点\n"
            "| 方法 | 端点 | 说明 |\n"
            "|------|------|------|\n"
            "| GET | /account | 账户信息、余额 |\n"
            "| GET | /instances | 列出所有实例 |\n"
            "| GET | /instances/{id} | 单个实例详情 |\n"
            "| POST | /instances/{id}/reboot | 重启 |\n"
            "| POST | /instances/{id}/action | start/stop/halt |\n"
            "| POST | /instances | 创建实例 |\n"
            "| DELETE | /instances/{id} | 删除实例 |\n\n"
            "## 现有实例\n"
            "- 149.28.44.218 (Alpine, ewr, $2.5/mo)\n\n"
            "## Python 示例\n"
            "```python\n"
            "import requests\n"
            'headers = {"Authorization": "Bearer " + API_KEY}\n'
            'r = requests.get("https://api.vultr.com/v2/instances", headers=headers)\n'
            'for inst in r.json().get("instances", []):\n'
            '    print(inst["id"], inst["main_ip"], inst["status"])\n'
            "```"
        ),
        "tags": ["vultr", "api", "云端"],
    },
    {
        "title": "ConoHa VPS 3.0 API (OpenStack Nova)",
        "category": "知識",
        "content": (
            "## 认证\n"
            "- Identity: https://identity.c3j1.conoha.io/v3/auth/tokens\n"
            "- Compute: https://compute.c3j1.conoha.io/v2.1\n"
            "- Keystone v3, Token 在响应头 x-subject-token，有效期 24 小时\n\n"
            "## 主要端点\n"
            "| 方法 | 端点 | 说明 |\n"
            "|------|------|------|\n"
            "| POST | /v3/auth/tokens | 获取 Token |\n"
            "| GET | /v2.1/servers/detail | 列出所有服务器 |\n"
            "| GET | /v2.1/servers/{id} | 单个服务器详情 |\n"
            "| POST | /v2.1/servers/{id}/os-server-actions | 服务器动作 |\n"
            "| POST | /v2.1/servers | 创建服务器 |\n"
            "| DELETE | /v2.1/servers/{id} | 删除服务器 |\n\n"
            "## 现有服务器\n"
            "- vm-6d4d176a-a5 (IP: 163.44.124.142, ACTIVE)\n\n"
            "## Python 示例\n"
            "```python\n"
            "import requests\n"
            'payload = {"auth": {"identity": {"methods": ["password"],\n'
            '    "password": {"user": {"id": USER_ID, "password": PASSWORD}}},\n'
            '    "scope": {"project": {"id": TENANT_ID}}}}\n'
            "resp = requests.post(IDENTITY_URL, json=payload)\n"
            'token = resp.headers["x-subject-token"]\n'
            'servers = requests.get(f"{COMPUTE_URL}/servers/detail",\n'
            '    headers={"X-Auth-Token": token}).json()\n'
            "```"
        ),
        "tags": ["conoha", "openstack", "nova", "云端"],
    },
    {
        "title": "Namecheap DNS API",
        "category": "知識",
        "content": (
            "## API 端点\n"
            "https://api.namecheap.com/xml.response\n\n"
            "## 限制\n"
            "- 个人账号，API 功能非常有限\n"
            "- 主要支持 DNS 操作\n"
            "- 受 Cloudflare 保护，浏览器自动化不稳定\n\n"
            "## 支持的命令\n"
            "| 命令 | 说明 |\n"
            "|------|------|\n"
            "| Namecheap.Domain.GetDomains | 列出域名 |\n"
            "| Namecheap.Dns.AddHosts | 添加 DNS 记录 |\n"
            "| Namecheap.Dns.DeleteHosts | 删除 DNS 记录 |\n"
            "| Namecheap.Dns.GetHosts | 获取 DNS 记录 |\n"
            "| Namecheap.Domain.Renew | 续费域名 |\n\n"
            "## 已配置的 A 记录\n"
            "- *.sanbunto.online -> 163.44.124.142\n"
            "- comfy / nexus / llama / audio / ops"
        ),
        "tags": ["namecheap", "dns", "域名"],
    },
    {
        "title": "SQLite WAL 模式与性能调优",
        "category": "知識",
        "content": (
            "## WAL 模式优势\n"
            "- 读写不互斥，并发性能更好\n"
            "- 支持在线备份 (VACUUM INTO)\n"
            "- 日志追加写入，减少随机 I/O\n\n"
            "## 我们的配置\n"
            "```python\n"
            "cursor.execute(\"PRAGMA journal_mode=WAL\")       # WAL 模式\n"
            "cursor.execute(\"PRAGMA synchronous=NORMAL\")     # 性能/安全平衡\n"
            "cursor.execute(\"PRAGMA foreign_keys=ON\")        # 外键约束\n"
            "cursor.execute(\"PRAGMA cache_size=-64000\")      # 64MB 缓存\n"
            "cursor.execute(\"PRAGMA temp_store=MEMORY\")      # 临时表放内存\n"
            "cursor.execute(\"PRAGMA busy_timeout=5000\")      # 锁超时 5 秒\n"
            "```\n\n"
            "## 备份\n"
            "```bash\n"
            'sqlite3 ops.db ".backup backup.db"  # 手动备份\n'
            "python3 -m app.backup               # 程序备份\n"
            'sqlite3 ops.db ".restore backup.db" # 恢复\n'
            "```\n\n"
            "## 文件结构\n"
            "- ops.db: 主数据库\n"
            "- ops.db-wal: WAL 日志\n"
            "- ops.db-shm: WAL 共享内存"
        ),
        "tags": ["sqlite", "wal", "性能", "备份"],
    },
    # ── 貼文 ──────────────────────────────────────────────────────────────
    {
        "title": "运维系统架构总览",
        "category": "貼文",
        "content": (
            "## Ops Control System\n\n"
            "一套基于 FastAPI + React 的运维控制面板。\n\n"
            "### 技术栈\n"
            "- **后端**: FastAPI, SQLAlchemy, SQLite (WAL)\n"
            "- **前端**: React, Vite, xterm.js\n"
            "- **部署**: Supervisor, FRP, Nginx\n\n"
            "### 功能模块\n"
            "1. **资产清单** - 主机管理、SSH 配置\n"
            "2. **主机监控** - CPU/内存/磁盘/GPU 实时指标\n"
            "3. **服务监控** - 进程状态、Supervisor 管理\n"
            "4. **SSH 终端** - Web SSH, xterm.js\n"
            "5. **告警中心** - 告警管理、确认追踪\n"
            "6. **变更管理** - 部署/配置/维护记录\n"
            "7. **云端管理** - Vultr, ConoHa, Namecheap\n"
            "8. **笔记管理** - 知识库、Markdown 编辑器\n\n"
            "### 性能\n"
            "- 主机指标 ~5s 并行（原 ~180s 串行）\n"
            "- 服务检测 ~2.8s\n"
            "- Supervisor 状态 ~3s\n"
            "- API 缓存 TTL 30s"
        ),
        "tags": ["架构", "总览", "fastapi", "react"],
    },
    {
        "title": "存储方案设计",
        "category": "貼文",
        "content": (
            "## 四层存储架构\n\n"
            "| 层 | 技术 | 用途 |\n"
            "|---|---|---|\n"
            "| 关系型 | SQLite (WAL) | Users, Assets, Alerts, Notes, ExecLog |\n"
            "| 缓存 | 内存 dict | API 响应 30s TTL |\n"
            "| 文件 | storage/ | 笔记附件、导出报告、备份 |\n"
            "| 日志 | logs/ | Uvicorn, Supervisord |\n\n"
            "## 数据库表\n"
            "- users - 用户管理\n"
            "- assets - 主机资产\n"
            "- asset_services - 服务清单\n"
            "- alerts - 告警\n"
            "- changes - 变更记录\n"
            "- runbooks - 应急手册\n"
            "- notes - 笔记/知识库\n"
            "- exec_log - SSH 执行记录\n\n"
            "## 备份策略\n"
            "- 每日自动备份，保留 7 天\n"
            "- VACUUM INTO 在线备份\n"
            "- 备份目录 0700 权限"
        ),
        "tags": ["存储", "架构", "sqlite", "设计"],
    },
    # ── 待辦 ──────────────────────────────────────────────────────────────
    {
        "title": "Phase 2: 文件存储",
        "category": "待辦",
        "content": (
            "- [ ] 笔记附件上传 API\n"
            "- [ ] 附件下载/删除 API\n"
            "- [ ] FastAPI StaticFiles 服务附件\n"
            "- [ ] 导出功能 (CSV/JSON)\n"
            "- [ ] 笔记附件前端 UI"
        ),
        "tags": ["待办", "文件存储"],
    },
    {
        "title": "Phase 3: 历史追踪",
        "category": "待辦",
        "content": (
            "- [ ] metrics_history 表设计\n"
            "- [ ] 定时存储监控数据 (CronJob)\n"
            "- [ ] 监控趋势图 (前端 Chart)\n"
            "- [ ] ExecLog 前端展示页面\n"
            "- [ ] 执行记录筛选/搜索"
        ),
        "tags": ["待办", "监控", "历史"],
    },
]


def main():
    session = SessionLocal()
    now = datetime.now(UTC).replace(microsecond=0)
    imported = 0

    for nd in NOTES:
        note_id = nd["title"][:32].replace(" ", "-") + str(uuid.uuid4())[:8]
        note = Note(
            id=note_id,
            title=nd["title"],
            category=nd["category"],
            content=nd["content"],
            tags=json.dumps(nd["tags"], ensure_ascii=False),
            author="admin",
            pinned=False,
            published=True,
            version=1,
            created_at=now,
            updated_at=now,
        )
        session.add(note)
        imported += 1

    session.commit()
    print(f"Imported {imported} notes")
    session.close()


if __name__ == "__main__":
    main()
