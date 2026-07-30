"""Built-in workflow templates."""

TEMPLATES: list[dict] = []


def register(*templates: dict) -> None:
    """Register workflow templates."""
    TEMPLATES.extend(templates)


# ── Template: feature-log ──────────────────────────────────────────────────

register({
    "id": "feature-log",
    "name": "功能變更記錄",
    "description": "將本次功能變更整理後寫入筆記系統",
    "parameters": [
        {"name": "feature_name", "type": "str", "description": "功能/變更名稱", "required": True},
        {"name": "files_changed", "type": "list", "description": "修改的文件列表", "required": True},
        {"name": "description", "type": "str", "description": "變更描述", "required": True},
    ],
    "steps": [
        {
            "type": "llm",
            "name": "generate_doc",
            "config": {
                "system_prompt": "你是一位技術文檔撰寫專家。請根據提供的功能信息，撰寫一份簡潔的技術變更記錄。使用繁體中文，Markdown 格式。包含：概述、修改文件、技術細節。",
                "user_prompt": "功能名稱：{{feature_name}}\n修改文件：{{files_changed}}\n功能描述：{{description}}\n\n請撰寫技術變更記錄：",
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
