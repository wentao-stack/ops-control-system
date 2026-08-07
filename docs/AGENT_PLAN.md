# AI Agent 開發計劃

> 專案: OPS Control System
> 最後更新: 2026-08-07
> 狀態: Phase 1-4 已完成核心功能，Phase 3 部分完成

---

## 一、現狀

### 已完成

| 功能 | 狀態 | 說明 |
|------|------|------|
| LLM 適配層 | ✅ | OpenAI 兼容 API，串流 + 非串流，`qwen36-27b-no-think-v1` |
| Tool Registry | ✅ | 裝飾器註冊 + OpenAI function calling 格式 |
| 對話管理 | ✅ | 創建/列出/刪除/持久化，自動標題生成 |
| SSE 串流聊天 | ✅ | `conv_id` / `token` / `tool_use` / `tool_result` / `done` 事件 |
| 前端聊天 UI | ✅ | 側邊欄對話列表 + 聊天區 + Markdown 渲染 + 工具卡片 |
| Tool Calling Loop | ✅ | 最多 5 次迭代，工具執行 → 結果回傳 LLM |
| 工作流引擎 | ✅ | 5 種步驟 (llm/api/shell/note_api/note_create) |

### 現有 11 個工具（6 讀取 + 5 寫入/執行）

| # | 工具名 | 功能 | 類型 | 權限 |
|---|--------|------|------|------|
| 1 | `get_host_metrics` | SSH 收集遠端主機 CPU/記憶體/磁碟/GPU | 讀取 | read |
| 2 | `list_assets` | 資產列表，支援環境/健康狀態篩選 | 讀取 | read |
| 3 | `check_services` | SSH 偵測遠端主機 systemd 服務 | 讀取 | read |
| 4 | `get_alerts` | 告警列表，支援嚴重程度篩選 | 讀取 | read |
| 5 | `search_notes` | 筆記搜索，支援關鍵字/分類 | 讀取 | read |
| 6 | `get_changes` | 變更記錄，支援類型篩選 | 讀取 | read |
| 7 | `exec_ssh_command` | SSH 遠端命令執行 | 執行 | exec + confirm |
| 8 | `supervisor_action` | Supervisor 程序管理 | 執行 | exec + confirm |
| 9 | `create_note` | 創建筆記 | 寫入 | write |
| 10 | `acknowledge_alert` | 確認告警 | 寫入 | write |
| 11 | `search_runbooks` | 搜索 Runbook | 讀取 | read |

### 缺失

- [x] 寫入/執行類工具（Phase 1 已完成）
- [x] 權限控制（Phase 2 已完成 — read/write/exec 三級 + 前端 confirm）
- [x] Token 用量追蹤（Phase 3 已完成 — AgentUsage 模型 + API + 前端面板）
- [x] Agent 記憶系統（Phase 4 已完成 — AgentMemory 模型 + save_memory/get_memories 工具）
- [ ] 圖片上傳 + Vision API（Phase 3 待完成）
- [ ] Agent 主動監控端點（Phase 3 待完成）
- [ ] 自定義工具管理（Phase 4 待完成）
- [ ] SettingsPage 實作（目前空殼）

---

## 二、開發階段

### Phase 1 — 寫入型工具（高優先級）

讓 Agent 不只是「查看」，而是能「執行」運維操作。

#### 1.1 `exec_ssh_command` — 遠端命令執行

```
參數:
  - asset_id: str (必填) — 資產 ID
  - command: str (必填) — Shell 命令
  - timeout: int (可選, 預設 60) — 超時秒數

返回: stdout, stderr, exit_code, duration

安全:
  - 需要 confirm 事件發送到前端，用戶點擊確認後才執行
  - 記錄到 exec_log 表
  - 命令長度限制 500 字元
```

#### 1.2 `supervisor_action` — Supervisor 程序管理

```
參數:
  - asset_id: str (必填) — 資產 ID
  - process_name: str (必填) — 程序名稱
  - action: str (必填) — start | stop | restart

返回: 執行結果

安全:
  - 需要前端 confirm
  - 記錄到 changes 表（type=config）
```

#### 1.3 `create_note` — 創建筆記

```
參數:
  - title: str (必填)
  - content: str (必填) — Markdown
  - category: str (可選, 預設 "知識")
  - tags: list[str] (可選)

返回: note_id, note_url

安全:
  - 無需 confirm（低風險操作）
  - 作者標記為 "agent"
```

#### 1.4 `acknowledge_alert` — 確認告警

```
參數:
  - alert_id: int (必填)

返回: 確認結果

安全:
  - 無需 confirm（低風險操作）
```

#### 1.5 `search_runbooks` — 搜索 Runbook

```
參數:
  - query: str (可選) — 關鍵字
  - category: str (可選) — 分類

返回: Runbook 列表

安全:
  - 純讀取，無需 confirm
```

**交付物**: `backend/app/agent.py` 新增 5 個工具函數 + 前端 confirm UI

---

### Phase 2 — 安全與權限

#### 2.1 工具權限分級

```
等級:
  - read:  所有登入用戶可調用（現有 6 個工具）
  - write: 需要 role=admin（create_note, acknowledge_alert）
  - exec:  需要 role=admin + 前端二次確認（exec_ssh_command, supervisor_action）
```

#### 2.2 前端確認機制

```
流程:
  1. Agent 返回 tool_use 事件，標記 requires_confirm=true
  2. 前端顯示確認卡片：工具名 + 參數 + 風險提示
  3. 用戶點擊「確認執行」或「取消」
  4. 確認後後端才執行工具，返回 tool_result
  5. 取消後返回 "用戶取消了操作" 給 LLM
```

#### 2.3 命令審計日誌

```
新增 AgentToolCall 模型:
  - id, conversation_id, user, tool_name, tool_input, tool_result
  - confirmed_by: str | null
  - confirmed_at: datetime | null
  - created_at: datetime
```

**交付物**: 工具權限系統 + 前端確認 UI + AgentToolCall 審計表

---

### Phase 3 — 多模態與進階功能

#### 3.1 圖片理解

```
功能:
  - 用戶上傳截圖（錯誤畫面、監控圖表）
  - Agent 調用 vision API 分析圖片
  - 結合文字上下文給出診斷建議

實現:
  - 前端新增圖片上傳按鈕
  - 後端調用 LLM vision endpoint（如果模型支援）
  - 或使用獨立的 vision model
```

#### 3.2 Agent 主動監控

```
功能:
  - 定時任務調用 Agent 檢查系統健康
  - 異常時自動創建告警或筆記
  - 透過 webhook 推送通知

實現:
  - 後端新增 /api/v1/agent/inspect 端點
  - 可與 cronjob 或 workflow 結合
```

#### 3.3 Token 用量追蹤

```
新增 AgentUsage 模型:
  - id, user, conversation_id, model
  - prompt_tokens, completion_tokens, total_tokens
  - cost_usd (可選)
  - created_at: datetime

功能:
  - 每次 LLM 呼叫後記錄用量
  - 前端顯示本月用量統計
  - 可設定月度預算告警
```

**交付物**: 圖片上傳 + vision API 適配 + 用量追蹤模型 + 統計頁面

---

### Phase 4 — Agent 記憶與知識圖譜

#### 4.1 長期記憶

```
功能:
  - Agent 自動從對話中提取關鍵信息（主機配置、排錯經驗）
  - 存為筆記或知識條目
  - 下次對話自動注入相關記憶

實現:
  - 對話結束後異步提取關鍵信息
  - 向量搜索相關記憶（可選，依賴 embedding model）
```

#### 4.2 自定義工具

```
功能:
  - 用戶透過 UI 定義自定義工具
  - 綁定到 workflow template 或 shell 腳本
  - Agent 可調用自定義工具

實現:
  - 後端新增 CustomTool 模型
  - 前端工具管理頁面
```

**交付物**: 記憶提取系統 + 自定義工具管理

---

## 三、技術架構

### 後端文件結構（目標）

```
backend/app/
├── agent.py              # 核心: LLM 適配 + Tool Registry + Chat Stream
├── agent_models.py       # ORM: AgentConversation, AgentMessage, AgentToolCall, AgentUsage
├── agent_schemas.py      # Pydantic: 所有 request/response schemas
├── agent_tools/          # 工具模組化（Phase 2+）
│   ├── __init__.py
│   ├── read_tools.py     # 現有 6 個讀取工具
│   ├── write_tools.py    # Phase 1 寫入工具
│   └── exec_tools.py     # Phase 1 執行工具（需確認）
```

### 前端文件結構（目標）

```
frontend/src/
├── pages/
│   └── AgentChatPage.tsx     # 聊天主頁面
├── components/
│   ├── AgentConfirmCard.tsx  # Phase 2: 工具確認卡片
│   ├── AgentImageUpload.tsx  # Phase 3: 圖片上傳
│   └── AgentUsageStats.tsx   # Phase 3: 用量統計
```

---

## 四、風險與注意事項

| 風險 | 緩解措施 |
|------|---------|
| Agent 執行危險命令 | 前端二次確認 + 審計日誌 + 命令白名單 |
| Token 費用失控 | 用量追蹤 + 月度預算告警 |
| LLM 幻觉導致錯誤操作 | 工具返回結構化數據，不讓 LLM 編造 |
| 工具執行超時 | 每個工具設定獨立超時，SSH 預設 60s |
| 併發對話衝突 | 每條對話獨立 session，工具執行串行化 |

---

## 五、檢查清單

### Phase 1 — 寫入型工具 ✅ 已完成
- [x] `exec_ssh_command` 工具（需前端確認）
- [x] `supervisor_action` 工具（需前端確認）
- [x] `create_note` 工具
- [x] `acknowledge_alert` 工具
- [x] `search_runbooks` 工具
- [x] 前端 confirm UI 組件
- [x] exec_log 自動記錄
- [x] 測試: 每個工具的 unit test（33 個通過）

### Phase 2 — 安全與權限 ✅ 已完成
- [x] 工具權限分級（read/write/exec）
- [x] 角色檢查中間件
- [x] AgentToolCall 審計模型
- [x] 前端確認流程完整實現
- [x] 命令黑名單

### Phase 3 — 多模態與進階 🔄 部分完成
- [ ] 圖片上傳組件
- [ ] Vision API 適配
- [x] AgentUsage 用量追蹤模型
- [x] 用量統計 API + 前端展示
- [ ] 主動監控端點

### Phase 4 — 記憶與知識 🔄 部分完成
- [x] AgentMemory 記憶模型
- [x] save_memory 工具
- [x] get_memories 工具 + 記憶注入 system prompt
- [x] 記憶管理 API + 前端記憶面板
- [ ] 自定義工具管理
- [ ] 向量搜索（可選）

---

## 六、與現有模組的關聯

| Agent 功能 | 關聯模組 | 數據流 |
|-----------|---------|--------|
| `get_host_metrics` | `remote_monitor.py` | Agent → SSH → /proc → 指標 |
| `check_services` | `remote_service.py` | Agent → SSH → systemd → 服務列表 |
| `exec_ssh_command` | `remote.py` | Agent → 前端確認 → SSH → 命令執行 |
| `supervisor_action` | `remote_supervisor.py` | Agent → 前端確認 → SSH → Supervisor |
| `create_note` | `models.py`(Note) | Agent → DB → 筆記 |
| `search_notes` | `models.py`(Note) | Agent → DB → 筆記搜索 |
| `get_alerts` | `models.py`(Alert) | Agent → DB → 告警列表 |
| `get_changes` | `models.py`(Change) | Agent → DB → 變更記錄 |
| 工作流引擎 | `workflow_engine.py` | Agent 可觸發 workflow 執行 |
