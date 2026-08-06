# OPS Control System — 存儲方案設計

## 一、現狀分析

### 當前架構
```
backend/.data/ops-dev.db          ← SQLite (60KB)，開發用
frontend/src/pages/NotesPage.tsx  ← localStorage，純前端
logs/                             ← 運行日誌
```

### 問題
1. **SQLite 開發庫**：`ops-dev.db` 在 `.data/` 下，無 WAL 模式，無備份機制
2. **筆記數據分散**：Notes 存在瀏覽器 localStorage，換瀏覽器就丟失
3. **無歷史追蹤**：監控指標、SSH 執行記錄全部丟失
4. **無文件存儲**：日誌截圖、導出報告無處存放

---

## 二、存儲層設計

### 2.1 數據分層

```
┌──────────────────────────────────────────────────────────────────┐
│                        應用層 (FastAPI)                          │
├─────────────┬──────────────┬───────────────┬────────────────────┤
│  關係型數據  │  緩存/會話    │   文件存儲     │    日誌            │
│  SQLite     │  內存 dict   │  本地文件夾    │  RotatingFile      │
├─────────────┼──────────────┼───────────────┼────────────────────┤
│ Users       │ API 響應緩存  │ 筆記附件       │ Uvicorn access     │
│ Assets      │ JWT 黑名單    │ 導出報告       │ Uvicorn error      │
│ Alerts      │ WebSocket    │ 截圖/備份      │ supervisord        │
│ Changes     │ 會話狀態      │               │ frontend           │
│ Runbooks    │              │               │ backend            │
│ Notes ✨    │              │               │                    │
│ ExecLog ✨  │              │               │                    │
│ Metrics ✨  │              │               │                    │
└─────────────┴──────────────┴───────────────┴────────────────────┘
```

### 2.2 目錄結構

```
backend/
├── .data/
│   ├── ops.db                          ← 主數據庫 (WAL 模式)
│   ├── ops.db-wal                      ← WAL 日誌
│   ├── ops.db-shm                      ← WAL 共享內存
│   ├── sessions.json                   ← 會話/黑名單 (可選)
│   └── cache/                          ← 文件緩存
│       └── *.json                      ← 預先計算的緩存
├── storage/                            ← 文件存儲
│   ├── notes/                          ← 筆記附件
│   │   └── {note_id}/
│   │       ├── image_001.png
│   │       └── screenshot.png
│   ├── exports/                        ← 導出文件
│   │   └── {date}_{type}.csv
│   └── backups/                        ← 數據庫備份
│       └── ops_20260729.sql
└── logs/                               ← 運行日誌（已移除，使用 supervisor/log/）
```

> **注意**: `start.sh` 已移除，日誌統一在 `supervisor/log/` 目錄下。
```

---

## 三、數據庫設計

### 3.1 新增表

#### `notes` — 筆記/知識管理

```sql
CREATE TABLE notes (
    id              TEXT PRIMARY KEY,              -- UUID-like, 前端生成
    title           TEXT NOT NULL,
    category        TEXT NOT NULL,                  -- '筆記' | '知識' | '貼文' | '待辦'
    content         TEXT NOT NULL DEFAULT '',       -- Markdown 內容
    tags            TEXT NOT NULL DEFAULT '[]',     -- JSON 數組 ["tag1", "tag2"]
    author          TEXT NOT NULL DEFAULT 'admin',
    pinned          BOOLEAN NOT NULL DEFAULT 0,
    published       BOOLEAN NOT NULL DEFAULT 1,     -- 是否公開
    version         INTEGER NOT NULL DEFAULT 1,     -- 版本號
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NOT NULL
);

CREATE INDEX idx_notes_category ON notes(category);
CREATE INDEX idx_notes_pinned   ON notes(pinned DESC, updated_at DESC);
CREATE INDEX idx_notes_author   ON notes(author);
```

#### `exec_log` — SSH 遠程執行記錄

```sql
CREATE TABLE exec_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id        TEXT NOT NULL,
    command         TEXT NOT NULL,
    stdout          TEXT DEFAULT '',
    stderr          TEXT DEFAULT '',
    exit_code       INTEGER NOT NULL DEFAULT 0,
    duration        REAL NOT NULL DEFAULT 0,         -- 秒
    user            TEXT NOT NULL DEFAULT 'admin',
    created_at      DATETIME NOT NULL
);

CREATE INDEX idx_exec_log_asset ON exec_log(asset_id, created_at DESC);
CREATE INDEX idx_exec_log_user  ON exec_log(user, created_at DESC);
```

#### `metrics_history` — 主機監控歷史（可選，長期存儲）

```sql
CREATE TABLE metrics_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id        TEXT NOT NULL,
    cpu_percent     REAL,
    mem_percent     REAL,
    disk_percent    REAL,
    load_avg_1      REAL,
    swap_percent    REAL,
    collected_at    DATETIME NOT NULL
);

CREATE INDEX idx_metrics_asset_time ON metrics_history(asset_id, collected_at DESC);
```

### 3.2 現有表優化

```sql
-- 為現有表添加缺失的索引
CREATE INDEX IF NOT EXISTS idx_assets_environment ON assets(environment);
CREATE INDEX IF NOT EXISTS idx_alerts_created     ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_status     ON changes(status, created_at DESC);
```

---

## 四、SQLite 配置優化

### 4.1 WAL 模式 + 性能調優

```python
# database.py
from sqlalchemy import create_engine, event
from sqlalchemy.pool import StaticPool

DATABASE_URL = "sqlite:////home/wentao/project/ops-control-system/backend/.data/ops.db"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,          # 連接健康檢查
)

@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    """啟用 WAL 模式、外鍵約束、WAL 同步"""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")       # WAL 模式，併發讀寫
    cursor.execute("PRAGMA synchronous=NORMAL")      # 性能/安全平衡
    cursor.execute("PRAGMA foreign_keys=ON")         # 外鍵約束
    cursor.execute("PRAGMA cache_size=-64000")       # 64MB 緩存
    cursor.execute("PRAGMA temp_store=MEMORY")       # 臨時表放內存
    cursor.execute("PRAGMA busy_timeout=5000")       # 鎖超時 5 秒
    cursor.close()
```

### 4.2 自動備份

```python
# 每天備份一次，保留最近 7 天
import subprocess
from pathlib import Path

BACKUP_DIR = Path("/home/wentao/project/ops-control-system/backend/storage/backups")

def backup_database():
    """SQLite 在線備份 (VACUUM INTO)"""
    now = datetime.now().strftime("%Y%m%d")
    backup_file = BACKUP_DIR / f"ops_{now}.db"
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    from sqlalchemy import text
    with engine.connect() as conn:
        conn.execute(text(f"VACUUM INTO '{backup_file}'"))
        conn.commit()

    # 清理 7 天前的備份
    for f in sorted(BACKUP_DIR.glob("ops_*.db")):
        if (datetime.now() - datetime.fromtimestamp(f.stat().st_mtime)).days > 7:
            f.unlink()
```

---

## 五、文件存儲設計

### 5.1 筆記附件

```
storage/notes/{note_id}/
├── image_001.png       # 筆記中插入的圖片
├── screenshot.png      # 截圖附件
└── metadata.json       # { "note_id": "...", "files": [...] }
```

API 設計：
```
POST   /api/v1/notes/{id}/attachments    # 上傳附件
GET    /api/v1/notes/{id}/attachments    # 列出附件
GET    /api/v1/notes/{id}/attachments/{filename}  # 下載附件
DELETE /api/v1/notes/{id}/attachments/{filename}  # 刪除附件
```

### 5.2 導出功能

```
storage/exports/
├── notes_20260729.csv
├── assets_20260729.json
└── metrics_20260729.csv
```

API 設計：
```
POST   /api/v1/export/notes     # 導出筆記為 CSV/JSON
POST   /api/v1/export/assets    # 導出資產清單
POST   /api/v1/export/metrics   # 導出監控歷史
```

---

## 六、緩存策略

### 6.1 現有緩存（保持）

```python
# main.py 中的內存緩存，30 秒 TTL
_cache: dict[str, tuple[Any, float]] = {}
CACHE_TTL = 30  # seconds
```

適用：`/hosts/metrics`, `/hosts/services`, `/supervisor/status`

### 6.2 新增緩存

| 資源 | 緩存方式 | TTL | 失效條件 |
|------|---------|-----|---------|
| 筆記列表 | 內存 dict | 10s | 新增/編輯筆記 |
| 資產總覽 | 內存 dict | 30s | 資產變更 |
| SSH 執行結果 | 不緩存 | - | 每次都執行 |

---

## 七、遷移計劃

### Phase 1 — 數據庫升級（本次）

- [x] 設計方案
- [ ] `database.py` 添加 WAL 模式配置
- [ ] `models.py` 添加 `Note`, `ExecLog` 模型
- [ ] `schemas.py` 添加對應 Pydantic schema
- [ ] `main.py` 添加 Notes CRUD API
- [ ] 將 localStorage 筆記遷移到 SQLite（一次性導入按鈕）
- [ ] 數據庫自動備份腳本

### Phase 2 — 文件存儲

- [ ] 創建 `storage/` 目錄結構
- [ ] 筆記附件上傳 API
- [ ] 導出功能 API
- [ ] 靜態文件服務（FastAPI StaticFiles）

### Phase 3 — 歷史追蹤

- [ ] `exec_log` 自動記錄 SSH 執行
- [ ] `metrics_history` 定時存儲監控數據
- [ ] 監控趨勢圖（前端）

---

## 八、安全考量

| 風險 | 措施 |
|------|------|
| SQLite 文件暴露 | `.data/` 不在 web root，不通過 StaticFiles 暴露 |
| 附件上傳大小 | 限制 10MB/文件，只允許 image/png, image/jpeg, application/pdf |
| 備份文件敏感 | `storage/backups/` 設置 0700 權限 |
| 日誌輪轉 | 已有 `stdout_logfile_maxbytes=20MB` + `maxbytes=50MB` |

---

## 九、備份與災難恢復

```bash
# 手動備份
sqlite3 backend/.data/ops.db ".backup backend/storage/backups/ops_manual.db"

# 恢復
sqlite3 backend/.data/ops.db ".restore backend/storage/backups/ops_20260729.db"

# 自動備份 (crontab)
# 0 3 * * * cd /home/wentao/project/ops-control-system && python3 -m app.backup
```
