"""Built-in workflow templates."""

TEMPLATES: list[dict] = []


def register(*templates: dict) -> None:
    """Register workflow templates."""
    TEMPLATES.extend(templates)


# ── Template: write-doc ────────────────────────────────────────────────────

register({
    "id": "write-doc",
    "name": "寫功能文檔",
    "description": "根據功能描述生成 Markdown 文檔並寫入筆記",
    "parameters": [
        {"name": "feature_name", "type": "str", "description": "功能名稱", "required": True},
        {"name": "files_changed", "type": "list", "description": "修改的文件列表", "required": True},
        {"name": "description", "type": "str", "description": "功能描述", "required": True},
        {"name": "category", "type": "str", "description": "筆記分類", "default": "知識"},
        {"name": "tags", "type": "list", "description": "標籤", "default": []},
    ],
    "steps": [
        {
            "type": "llm",
            "name": "generate_doc",
            "config": {
                "system_prompt": "你是一位技術文檔撰寫專家。請根據提供的功能信息，撰寫一份完整的技術文檔。使用繁體中文，Markdown 格式。包含：概述、修改文件、技術細節、API 變更、驗收標準。",
                "user_prompt": "功能名稱：{{feature_name}}\n修改文件：{{files_changed}}\n功能描述：{{description}}\n\n請撰寫技術文檔：",
            },
        },
        {
            "type": "note_create",
            "name": "save_note",
            "config": {},
        },
    ],
    "is_active": True,
})


# ── Template: weekly-report ────────────────────────────────────────────────

register({
    "id": "weekly-report",
    "name": "生成週報",
    "description": "根據指定時間範圍的變更、執行記錄和告警生成週報",
    "parameters": [
        {"name": "week_start", "type": "str", "description": "週起始日期 (YYYY-MM-DD)", "required": True},
        {"name": "week_end", "type": "str", "description": "週結束日期 (YYYY-MM-DD)", "required": True},
    ],
    "steps": [
        {
            "type": "api",
            "name": "fetch_changes",
            "config": {
                "url": "http://127.0.0.1:18080/api/v1/changes",
                "method": "GET",
            },
        },
        {
            "type": "api",
            "name": "fetch_alerts",
            "config": {
                "url": "http://127.0.0.1:18080/api/v1/alerts",
                "method": "GET",
            },
        },
        {
            "type": "llm",
            "name": "generate_report",
            "config": {
                "system_prompt": "你是一位運維工程師。請根據提供的數據生成一份週報。使用繁體中文，Markdown 格式。包含：工作摘要、變更記錄、告警統計、下週計劃建議。",
                "user_prompt": "週期：{{week_start}} 至 {{week_end}}\n\n變更記錄：{{step_fetch_changes}}\n\n告警記錄：{{step_fetch_alerts}}\n\n請生成週報：",
            },
        },
        {
            "type": "note_create",
            "name": "save_note",
            "config": {},
        },
    ],
    "is_active": True,
})


# ── Template: incident-report ──────────────────────────────────────────────

register({
    "id": "incident-report",
    "name": "生成事件報告",
    "description": "根據事件信息生成事件報告並寫入筆記",
    "parameters": [
        {"name": "incident_title", "type": "str", "description": "事件標題", "required": True},
        {"name": "description", "type": "str", "description": "事件描述", "required": True},
        {"name": "affected_hosts", "type": "list", "description": "受影響主機", "default": []},
    ],
    "steps": [
        {
            "type": "api",
            "name": "fetch_metrics",
            "config": {
                "url": "http://127.0.0.1:18080/api/v1/hosts/metrics?cache=true",
                "method": "GET",
            },
        },
        {
            "type": "api",
            "name": "fetch_alerts",
            "config": {
                "url": "http://127.0.0.1:18080/api/v1/alerts",
                "method": "GET",
            },
        },
        {
            "type": "llm",
            "name": "generate_report",
            "config": {
                "system_prompt": "你是一位運維工程師。請根據提供的數據生成一份事件報告。使用繁體中文，Markdown 格式。包含：事件概述、影響範圍、時間線、根本原因分析、解決措施、預防建議。",
                "user_prompt": "事件標題：{{incident_title}}\n事件描述：{{description}}\n受影響主機：{{affected_hosts}}\n\n監控數據：{{step_fetch_metrics}}\n\n告警記錄：{{step_fetch_alerts}}\n\n請生成事件報告：",
            },
        },
        {
            "type": "note_create",
            "name": "save_note",
            "config": {},
        },
    ],
    "is_active": True,
})


# ── Template: session-log ──────────────────────────────────────────────────

register({
    "id": "session-log",
    "name": "對話記錄",
    "description": "將本次對話內容整理後寫入筆記系統",
    "parameters": [
        {"name": "topic", "type": "str", "description": "對話主題/標題", "required": True},
        {"name": "summary", "type": "str", "description": "對話摘要內容", "required": True},
        {"name": "category", "type": "str", "description": "筆記分類", "default": "對話"},
        {"name": "tags", "type": "list", "description": "標籤", "default": []},
    ],
    "steps": [
        {
            "type": "llm",
            "name": "format_note",
            "config": {
                "system_prompt": "你是一位技術記錄助手。請將提供的對話摘要整理為結構化的筆記文檔。使用繁體中文，Markdown 格式。包含：主題、討論內容、決策與結論、待辦事項（如有）。保持簡潔專業。",
                "user_prompt": "主題：{{topic}}\n\n對話摘要：{{summary}}\n\n請整理為筆記文檔：",
            },
        },
        {
            "type": "note_create",
            "name": "save_note",
            "config": {},
        },
    ],
    "is_active": True,
})
