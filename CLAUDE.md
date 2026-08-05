# OPS Control System — Agent 工作手冊

> 此文件由 Hermes Agent 自動載入。每次進入這個專案時，請先讀取此文件以了解開發流程。

## 專案概覽

遠端伺服器作業控制平台。FastAPI 後端 + React/Vite 前端。

- **後端**: `backend/` — FastAPI, SQLAlchemy, SQLite (WAL), port 18080
- **前端**: `frontend/` — React + TypeScript + Vite, dev port 5173
- **部署**: FRP TCP :18080 → `https://ops.sanbunto.online`（後端掛載 `frontend/dist` 作為 SPA）
- **分支**: `agent/developer/TASK-*`（開發分支），`main`（主分支）
- **工作目錄**: `/home/wentao/project/ops-control-system`

## 模組速查

| 模組 | 後端檔案 | 前端頁面 | API 前綴 |
|------|---------|---------|---------|
| 資產庫存 | `models.py`(Asset) | `AssetsPage`, `AssetDetailPage` | `/api/v1/assets` |
| 主機監控 | `remote_monitor.py` | `MonitoringPage` | `/api/v1/hosts/metrics` |
| 服務偵測 | `remote_service.py` | `ServicesPage` | `/api/v1/hosts/services` |
| Supervisor | `remote_supervisor.py` | `ServicesPage` | `/api/v1/supervisor/` |
| SSH 終端 | `webssh.py` | `WebTerminal` | `/ws/ssh/{asset_id}` |
| SSH 命令 | `remote.py` | `RemotePage` | `/api/v1/remote/` |
| AI Agent | `agent.py` + 6 tools | `AgentChatPage` | `/api/v1/agent/` |
| 筆記知識庫 | `models.py`(Note) | `NotesPage`, `NoteDetailPage` | `/api/v1/notes` |
| 工作流 | `workflow_engine.py` | `WorkflowPage` | `/api/v1/workflow/` |
| 程式碼瀏覽 | — | `CodeBrowsePage` | `/api/v1/code/` |
| 雲端平台 | — | `CloudsPage` | —（靜態參考頁） |

## Agent 工具（6 個）

`backend/app/agent.py` 註冊了以下工具供 LLM 調用：

1. `get_host_metrics` — 所有遠端主機監控數據（CPU/記憶體/磁碟/GPU）
2. `list_assets` — 資產列表，支援環境/狀態篩選
3. `check_services` — 遠端主機服務偵測（systemd/Docker/進程）
4. `get_alerts` — 系統告警列表，支援嚴重程度篩選
5. `search_notes` — 筆記搜索，支援關鍵字/分類
6. `get_changes` — 變更記錄，支援類型/狀態篩選

## 開發流程（必須遵守）

### 1. 修改代碼

```bash
# 前端：修改 frontend/src/ 下的 .tsx / .css 等檔案
# 後端：修改 backend/app/ 下的 .py 檔案
```

### 2. 類型檢查（前端）

```bash
cd /home/wentao/project/ops-control-system/frontend
npx tsc --noEmit  # 必須通過
```

### 3. 生產構建（前端修改後必須執行）

```bash
cd /home/wentao/project/ops-control-system/frontend
npm run build  # 產生 frontend/dist/
```

> **關鍵**: `ops.sanbunto.online` 走 FRP → 後端 :18080 → 掛載 `frontend/dist`。
> 不 build 的話線上不會看到更動。

### 4. Git 提交（自動）

```bash
cd /home/wentao/project/ops-control-system
git add -A
git commit -m "類型: 描述"
```

> 每次改完自動 commit，不需要確認。commit 類型：feat / fix / docs / refactor / chore。

### 5. 重啟服務

```bash
cd /home/wentao/project/ops-control-system
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-backend ocs-frontend
```

### 6. 驗證部署

```bash
curl -s -o /dev/null -w "%{http_code}" https://ops.sanbunto.online/
```

## 前端開發規範

### API 呼叫

一律使用 `import { api } from '../auth'`，不使用 axios 或原生 fetch。

```tsx
const data = await api<SomeType>('/api/v1/endpoint');
```

`api()` 自動附加 JWT token，401 時自動登出並重新載入頁面。支援 SSE 串流回應。

### 路由

路由表在 `frontend/src/main.tsx`，新增頁面需同時在此註冊：

```tsx
<Route path="/new-page" element={<NewPage />} />
```

### 導航欄

側邊導航欄在 `frontend/src/Layout.tsx`，新增頁面需加入導航項目。

### 類型定義

共用 TypeScript 類型放在 `frontend/src/types.ts`。

### Vite Proxy

開發模式下 Vite 代理 `/api` 和 `/ws` 到後端 `:18080`（見 `vite.config.ts`）。

## 後端開發規範

### 靜態檔案掛載

`backend/app/main.py` 第 1273 行附近，FastAPI 掛載 `frontend/dist` 作為 SPA。
生產模式下後端同時提供 API 和前端靜態檔案。

### 資料庫

- SQLite WAL 模式，資料庫位於 `backend/.data/ops.db`
- ORM 模型在 `models.py`，新增模型後記得在 `database.py` 的 Base.metadata 中註冊
- 備份工具：`backend/app/backup.py`（VACUUM INTO，7 天保留）

### 新增 API 路由

在 `main.py` 中新增，使用 `@router.api_route` 或 `@app.get` 等裝飾器。
需要認證的路由使用 `get_current_user` 依賴注入。

### 新增 Pydantic Schema

在 `schemas.py` 中定義 request/response schema。

## 快捷命令

| 用途 | 命令 |
|------|------|
| 啟動 | `./backend/.venv/bin/supervisord -c supervisor/supervisord.conf` |
| 重啟 | `./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-backend ocs-frontend` |
| 停止 | `./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf stop ocs-backend ocs-frontend` |
| 狀態 | `./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf status` |
| TS 檢查 | `cd frontend && npx tsc --noEmit` |
| 構建 | `cd frontend && npm run build` |
| 測試 | `cd backend && python3 -m pytest` |
| 一鍵啟動 | `./start.sh -b`（背景）/ `./start.sh -s`（停止）/ `./start.sh -S`（狀態） |

## 安全規則

- 禁止用 `write_file` 覆蓋現有原始碼（只能 patch）
- 禁止 commit secrets、token、密碼
- 大檔修改前先 `search_files` 找 symbol，再 `read_file` 讀相關區段
- `backend/.env` 不進入 Git，包含 LLM API 金鑰

## 日誌位置

| 日誌 | 路徑 |
|------|------|
| 後端 stdout | `supervisor/log/ocs-backend.log` |
| 後端 stderr | `supervisor/log/ocs-backend-error.log` |
| 前端 stdout | `supervisor/log/ocs-frontend.log` |
| 前端 stderr | `supervisor/log/ocs-frontend-error.log` |
| Supervisor | `supervisor/supervisord.log` |
