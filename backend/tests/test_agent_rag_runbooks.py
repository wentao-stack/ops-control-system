"""RAG regression tests for curated, executable Runbooks."""

import json

from app.agent_rag import chunk_runbook
from app.models import Runbook
from app.seed import seed_development_data


def test_curated_runbooks_are_seeded_with_retrieval_metadata(session):
    seed_development_data(session)
    runbooks = session.query(Runbook).filter(Runbook.status == "active").all()

    assert len(runbooks) == 12
    nginx = next(item for item in runbooks if "Nginx 502" in item.title)
    assert "nginx" in json.loads(nginx.tags)
    assert nginx.symptoms
    assert nginx.verification_steps
    assert nginx.rollback_steps

    backup = next(item for item in runbooks if "SQLite 資料庫備份" in item.title)
    assert {"sqlite", "backup", "restore"}.issubset(json.loads(backup.tags))
    assert "禁止直接覆蓋目前資料庫" in backup.steps

    certificate = next(item for item in runbooks if "TLS 握手異常" in item.title)
    assert {"tls", "ssl", "certificate"}.issubset(json.loads(certificate.tags))
    assert "不得在聊天中展示私鑰" in certificate.steps

    ssh = next(item for item in runbooks if "SSH 連線失敗" in item.title)
    assert "最小權限" in ssh.description
    assert "最後一條管理存取路徑" in ssh.rollback_steps


def test_runbook_chunks_keep_discovery_procedure_and_safety_context():
    chunks = chunk_runbook({
        "id": 42,
        "title": "Nginx 502 / upstream 異常",
        "category": "web",
        "description": "定位 upstream 異常。",
        "tags": json.dumps(["nginx", "502"]),
        "affected_assets": json.dumps(["archlinux"]),
        "symptoms": "Nginx 回傳 502",
        "steps": "1. 檢查 error log。",
        "verification_steps": "目標 URL 回應正常。",
        "rollback_steps": "還原設定。",
        "status": "active",
        "version": 1,
    })

    assert [chunk["metadata"]["chunk_type"] for chunk in chunks] == ["discovery", "procedure", "rollback"]
    assert chunks[0]["metadata"]["source"] == "runbook"
    assert chunks[0]["metadata"]["tags"] == "nginx,502"
    assert chunks[0]["metadata"]["affected_assets"] == "archlinux"
    assert "Nginx 回傳 502" in chunks[0]["text"]
    assert "目標 URL 回應正常" in chunks[1]["text"]
