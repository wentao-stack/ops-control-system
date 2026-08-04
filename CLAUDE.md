# OPS Control System — Agent 工作手冊

> 此文件由 Hermes Agent 自動載入。每次進入這個專案時，請先讀取此文件以了解開發流程。

## 專案概覽

遠端伺服器作業控制平台。FastAPI 後端 + React/Vite 前端。

- **後端**: `backend/` — FastAPI, SQLAlchemy, SQLite, port 18080
- **前端**: `frontend/` — React + TypeScript + Vite, dev port 5173
- **部署**: FRP 轉端口 18080 → `https://ops.sanbunto.online`
- **分支**: `agent/developer/TASK-*`（開發分支），`main`（主分支）

## 開發流程（必須遵守）

### 1. 修改前端代碼

```bash
# 修改 frontend/src/ 下的 .tsx / .css 等檔案
```

### 2. 類型檢查

```bash
cd /home/wentao/project/ops-control-system/frontend
npx tsc --noEmit  # 必須通過
```

### 3. 生產構建（必須步驟）

```bash
cd /home/wentao/project/ops-control-system/frontend
npm run build  # 產生 frontend/dist/
```

> **關鍵**: `ops.sanbunto.online` 走 FRP → 後端 18080 → 掛載 `frontend/dist`。
> 不 build 的話線上不會看到更動。

### 4. Git 提交（自動）

```bash
cd /home/wentao/project/ops-control-system
git add -A
git commit -m "描述"
```

> 每次改完自動 commit，不需要確認。

### 5. 重啟服務

```bash
cd /home/wentao/project/ops-control-system
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-backend ocs-frontend
```

### 6. 驗證部署

```bash
curl -s -o /dev/null -w "%{http_code}" https://ops.sanbunto.online/
```

## 前端 API 呼叫

一律使用 `import { api } from '../auth'`，不使用 axios 或 fetch。

```tsx
const data = await api<SomeType>('/api/v1/endpoint');
```

## 後端靜態檔案掛載

`backend/app/main.py` 約第 1233 行，FastAPI 掛載 `frontend/dist` 作為 SPA：

```python
app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="spa")
```

## 安全規則

- 禁止用 `write_file` 覆蓋現有原始碼（只能 patch）
- 禁止 commit secrets、token、密碼
- 大檔修改前先 `search_files` 找 symbol，再 `read_file` 讀相關區段

## 快捷命令

| 用途 | 命令 |
|------|------|
| 啟動 | `./backend/.venv/bin/supervisord -c supervisor/supervisord.conf` |
| 重啟 | `./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-backend ocs-frontend` |
| TS 檢查 | `cd frontend && npx tsc --noEmit` |
| 構建 | `cd frontend && npm run build` |
| 狀態 | `./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf status` |
