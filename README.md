# Ops Control System

Remote server operations control platform — inventory, monitoring, SSH execution, and process management.

## Architecture

- **Backend**: FastAPI + SQLAlchemy + SQLite (local dev)
- **Frontend**: React + TypeScript + Vite
- **Authentication**: JWT (bcrypt password hashing, python-jose)
- **Remote access**: SSH via paramiko (command exec, metrics, service detection)
- **Process management**: Supervisor remote control over SSH
- **Web terminal**: WebSocket-based interactive SSH terminal

## Features

### Inventory & Dashboard
- Server asset management with health status, environment, criticality
- Inventory summary with breakdowns by health and environment
- Asset detail view with associated services

### Remote Operations
- **SSH command execution**: Run commands on remote hosts via SSH
- **Host ping**: Batch ping all SSH-configured assets
- **Host metrics**: Collect CPU, memory, disk, GPU metrics from remote hosts via `/proc`
- **Service detection**: Detect running services (systemd) on remote hosts

### Supervisor Process Management
- View supervisor process status across all managed hosts
- Start/stop/restart/signal supervisor-managed processes
- Tail stdout/stderr logs from supervisor processes

### Web SSH Terminal
- Interactive SSH terminal via WebSocket (`/ws/ssh/{asset_id}`)
- Supports terminal resize (cols/rows)

### Alerts, Changes & Runbooks
- Alert listing with severity filtering and acknowledgment tracking
- Change log with type and status filtering
- Runbook library with categorization

## Project Structure

### Root

```
.gitignore                          # Git 忽略規則（.venv/, node_modules/, .data/, dist/, .env 等）
CLAUDE.md                           # Agent 工作手冊（開發流程、快捷命令、安全規則）
README.md                           # 本文件
# 無（已移除，統一使用 Supervisor 管理服務）
```

### Backend — `backend/`

FastAPI 後端，Python 3.12+，SQLite 資料庫。

```
backend/
├── .env                            # 環境變數（OPENAI_API_KEY、OPENAI_BASE_URL 等，不進入 Git）
├── .data/                          # SQLite 資料庫目錄（WAL 模式，不進入 Git）
│   └── ops.db                      #   主資料庫
├── pyproject.toml                  # Python 專案配置（setuptools, 依賴, pytest）
├── .venv/                          # Python 虛擬環境（不進入 Git）
├── app/
│   ├── __init__.py                 # 套件宣告
│   ├── main.py                     # FastAPI 應用入口，所有 API 路由、靜態檔案掛載、CORS、中間件
│   ├── auth.py                     # JWT 認證（bcrypt 密碼雜湊、python-jose token 簽發/驗證）
│   ├── database.py                 # SQLAlchemy engine、SessionLocal、Base，SQLite WAL 模式配置
│   ├── models.py                   # ORM 模型（Asset, User, Alert, Change, Runbook, Note, ExecLog 等）
│   ├── schemas.py                  # Pydantic request/response schemas（Asset, User, Alert 等）
│   ├── seed.py                     # 開發環境初始數據灌入（測試資產、用戶、告警等）
│   ├── seed_notes.py               # 筆記知識庫初始數據灌入（SSH 排錯記錄、FRP 架構等範例筆記）
│   ├── remote.py                   # SSH 遠端命令執行、批次 ping（paramiko）
│   ├── remote_monitor.py           # 遠端主機指標收集（CPU/記憶體/磁碟/GPU，透過 /proc）
│   ├── remote_service.py           # 遠端服務偵測（systemd unit 狀態掃描）
│   ├── remote_supervisor.py        # Supervisor 遠端程序管理（start/stop/restart/tail log 透過 SSH）
│   ├── monitor.py                  # 本機主機指標收集（/proc、psutil）
│   ├── webssh.py                   # WebSocket SSH 終端處理器（asyncssh + xterm 協議）
│   ├── agent.py                    # AI Agent 聊天引擎（LLM 呼叫、工具註冊、SSE 串流回應）
│   ├── agent_models.py             # Agent ORM 模型（AgentConversation, AgentMessage）
│   ├── agent_schemas.py            # Agent Pydantic schemas（對話/訊息的 request/response）
│   ├── workflow_engine.py          # 工作流引擎（LLM/API/Note/Script 步驟執行器、模板渲染）
│   ├── workflow_models.py          # 工作流 ORM 模型（WorkflowTemplate, WorkflowExecution）
│   ├── workflow_schemas.py         # 工作流 Pydantic schemas（模板/執行的 request/response）
│   ├── workflow_templates/
│   │   └── __init__.py             # 內建工作流模板（功能變更記錄等）
│   └── backup.py                   # SQLite 資料庫備份工具（VACUUM INTO、7 天保留策略）
├── tests/
│   ├── test_api.py                 # API 端點測試
│   ├── test_agent_schemas.py       # Agent schema 測試（確保不覆蓋預設模型）
│   └── test_workflow_engine.py     # 工作流引擎測試（LLM 步驟、API 步驟、筆記建立步驟）
└── storage/                        # 文件儲存目錄
    ├── notes/                      #   筆記附件
    ├── exports/                    #   匯出檔案
    └── backups/                    #   資料庫備份（ops_YYYYMMDD.db）
```

### Frontend — `frontend/`

React + TypeScript + Vite 前端 SPA。

```
frontend/
├── index.html                      # HTML 入口（root div, theme-color, 引入 main.tsx）
├── package.json                    # Node 依賴與腳本（React, Vite, xterm, react-syntax-highlighter 等）
├── tsconfig.json                   # TypeScript 編譯配置（strict, JSX, module resolution）
├── tsconfig.node.json              # Node 環境 TypeScript 配置（vite.config.ts 用）
├── vite.config.ts                  # Vite 配置（API proxy /api → :18080, /ws → :18080）
├── dist/                           # 生產構建產物（不進入 Git，由後端掛載為 SPA）
├── node_modules/                   # Node 依賴（不進入 Git）
└── src/
    ├── main.tsx                    # React 應用入口（BrowserRouter, AuthProvider, 路由表）
    ├── styles.css                  # 全域 CSS 樣式（深色主題、變數、reset）
    ├── types.ts                    # TypeScript 類型定義（Asset, Note, AgentConversation 等共用型別）
    ├── vite-env.d.ts               # Vite 客戶端類型宣告
    ├── auth.ts                     # 認證工具函數（api() 封裝 fetch, JWT 存取, 錯誤處理）
    ├── AuthProvider.tsx            # Auth Context Provider（登入狀態管理, useAuth hook）
    ├── LoginPage.tsx               # 登入頁面
    ├── Layout.tsx                  # 應用佈局（側邊導航欄, 頁面標題, 登出按鈕）
    ├── components/
    │   └── WebTerminal.tsx         # WebSocket SSH 終端元件（xterm.js + fit addon, 自動調整大小）
    └── pages/
        ├── OverviewPage.tsx        # 儀表板總覽（資產統計、健康狀態、環境分佈）
        ├── AssetsPage.tsx          # 資產清單（篩選、分頁、健康/環境標籤）
        ├── AssetDetailPage.tsx     # 資產詳情（SSH 配置、關聯服務、運行指標）
        ├── MonitoringPage.tsx      # 主機監控儀表板（CPU/記憶體/磁碟/GPU 即時指標）
        ├── ServicesPage.tsx        # 服務狀態總覽（跨主機 systemd 服務狀態）
        ├── RemotePage.tsx          # SSH 遠端命令執行（命令輸入、輸出顯示、執行歷史）
        ├── SettingsPage.tsx        # 用戶/系統設置
        ├── CloudsPage.tsx          # 雲端平台儀表板（Vultr/ConoHa VPS 帳戶與實例參考頁）
        ├── NotesPage.tsx           # 筆記/知識庫列表（分類篩選、分頁、釘選、Markdown 預覽）
        ├── NoteDetailPage.tsx      # 筆記詳情頁（Markdown 渲染、編輯、刪除、返回導航）
        ├── AgentChatPage.tsx       # AI Agent 聊天介面（對話列表、SSE 串流、工具調用顯示）
        ├── CodeBrowsePage.tsx      # 程式碼瀏覽器（左側檔案樹 + 右側語法高亮程式碼檢視）
        └── WorkflowPage.tsx        # 工作流管理（模板列表、建立/執行工作流、執行歷史）
```

### Supervisor — `supervisor/`

專案級 Supervisor 配置，管理後端與前端進程。

```
supervisor/
├── supervisord.conf                # Supervisor 主配置（unix socket, RPC, 包含 conf.d/*.conf）
├── conf.d/
│   ├── ocs-comfyui.conf            # ComfyUI 按需启动配置（:8188，不自动启动）
│   ├── ocs-deepseek-harness.conf   # DeepSeek Harness Web UI 按需启动配置（:3080，不自动启动）
│   ├── ocs-backend.conf            # 後端程序配置（uvicorn :18080, 自動重啟, 日誌輪轉）
│   └── ocs-frontend.conf           # 前端程序配置（Vite dev server :5173, 自動重啟）
├── log/                            # 運行日誌（不進入 Git）
│   ├── ocs-backend.log             #   後端 stdout 日誌
│   ├── ocs-backend-error.log       #   後端 stderr 日誌
│   ├── ocs-frontend.log            #   前端 stdout 日誌
│   └── ocs-frontend-error.log      #   前端 stderr 日誌
├── supervisord.log                 # Supervisor 自身日誌（不進入 Git）
├── supervisord.pid                 # PID 檔案（不進入 Git）
└── supervisor.sock                 # Unix socket（不進入 Git）
```

### Deploy — `deploy/`

生產部署配置模板。

```
deploy/
├── systemd/ops-control-system.service   # systemd 服務單元（啟動 supervisord, Restart=on-failure）
├── supervisor.conf                      # 系統級 Supervisor 配置（備用，使用 ~/.supervisor/ socket）
└── frp/ops-control-system.toml          # FRP 代理配置片段（HTTP :18080 → ops.sanbunto.online）
```

### Docs — `docs/`

專案設計文件。

```
docs/
├── COMFYUI.md                          # ComfyUI 啟停、健康檢查、日誌與 GPU 注意事項
└── STORAGE.md                          # 存儲方案設計（數據分層、SQLite WAL、備份策略、文件存儲架構）
```

### Logs — `logs/`

運行日誌目錄（不進入 Git）。

```
logs/
├── backend.log                         # 後端日誌（start.sh 模式）
└── frontend.log                        # 前端日誌（start.sh 模式）
```

## Quick Start

All services are managed by Supervisor under `supervisor/`. One command starts everything:

```bash
# Start (or restart) all services
./backend/.venv/bin/supervisord -c supervisor/supervisord.conf

# Check status
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf status

# Restart a single service
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-backend
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-frontend
```

Services:
- **ocs-backend** — FastAPI on `127.0.0.1:18080`
- **ocs-frontend** — Vite dev server on `127.0.0.1:5173`
- **ocs-comfyui** — ComfyUI on `0.0.0.0:8188`（按需啟動；詳見 `docs/COMFYUI.md`）
- **ocs-deepseek-harness** — DeepSeek Harness (dsh) Web UI on `127.0.0.1:3080`（按需啟動；dsh 安全限制只綁 127.0.0.1；LLM 走本地 llama-swap :9292，key 由 gitignore 的 `supervisor/env/ocs-deepseek-harness.env` 注入 `QWEN_API_KEY`）

Open `http://127.0.0.1:5173`. The Vite dev server proxies `/api` and `/ws` to the backend.

### First-time setup

```bash
# Backend
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
pip install supervisor        # project-level supervisor lives here

# Frontend
cd frontend
npm install
```

### Manual dev mode (without Supervisor)

Backend:

```bash
cd backend
. .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 18080
```

Frontend:

```bash
cd frontend
npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | Health check |
| POST | `/api/v1/auth/login` | JWT login |
| GET | `/api/v1/auth/me` | Current user info |
| GET | `/api/v1/inventory/summary` | Inventory summary |
| GET | `/api/v1/assets` | List assets (filterable, paginated) |
| GET | `/api/v1/assets/{id}` | Asset detail with services |
| GET | `/api/v1/alerts` | List alerts |
| GET | `/api/v1/changes` | List changes |
| GET | `/api/v1/runbooks` | List runbooks |
| POST | `/api/v1/remote/exec` | Execute command on remote host |
| POST | `/api/v1/remote/ping` | Ping all remote hosts |
| GET | `/api/v1/host/metrics` | Local host metrics |
| GET | `/api/v1/hosts/metrics` | All remote host metrics |
| GET | `/api/v1/hosts/services` | All remote host services |
| GET | `/api/v1/supervisor/status` | All supervisor process status |
| POST | `/api/v1/supervisor/action` | Supervisor process action |
| POST | `/api/v1/supervisor/tail` | Tail supervisor process logs |
| WS | `/ws/ssh/{asset_id}` | Interactive SSH terminal |

## Tests

```bash
cd backend
python3 -m pytest
```

The SQLite database is created locally at `backend/.data/ops-dev.db` and is intentionally ignored by Git.

## Deployment

`deploy/systemd/ops-control-system.service` runs the application on
`127.0.0.1:18080`. `deploy/frp/ops-control-system.toml` is a credential-free
proxy fragment for `ops.sanbunto.online`.

An operator must not install or restart the service/FRP proxy until the related
server-side task has verified DNS, TLS, FRPS routing, rollback, and an FRP token
rotation. No credential belongs in this repository.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPS_SECRET_KEY` | `dev-secret-key-change-in-production` | JWT signing key |
| `OPS_TOKEN_EXPIRE_MINUTES` | `1440` (24h) | JWT token expiration |
