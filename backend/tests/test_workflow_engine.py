from __future__ import annotations

import asyncio

from app import workflow_engine


class _FakeResponse:
    status_code = 201

    def json(self) -> dict:
        return {"id": "created-note"}


class _RecordingClient:
    last_request: dict | None = None

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url: str, *, json: dict, headers: dict):
        type(self).last_request = {"url": url, "json": json, "headers": headers}
        return _FakeResponse()


def test_note_api_uses_runtime_parameters_when_config_fields_are_empty(monkeypatch):
    monkeypatch.setattr(workflow_engine.httpx, "AsyncClient", _RecordingClient)

    result = asyncio.run(workflow_engine._run_note_api_step(
        {
            "method": "POST",
            "path": "/api/v1/notes",
            "fields": {},
        },
        {
            "title": "test",
            "category": "test",
            "content": "test",
            "tags": "test",
            "_auth_token": "workflow-token",
        },
    ))

    assert result == {"status": 201, "data": {"id": "created-note"}}
    assert _RecordingClient.last_request == {
        "url": "http://127.0.0.1:18080/api/v1/notes",
        "json": {
            "title": "test",
            "category": "test",
            "content": "test",
            "tags": ["test"],
        },
        "headers": {"Authorization": "Bearer workflow-token"},
    }


def test_note_api_runtime_parameters_override_config_defaults(monkeypatch):
    monkeypatch.setattr(workflow_engine.httpx, "AsyncClient", _RecordingClient)

    asyncio.run(workflow_engine._run_note_api_step(
        {
            "method": "POST",
            "path": "/api/v1/notes",
            "fields": {"title": "default", "category": "default"},
        },
        {
            "title": "runtime title",
            "category": "runtime category",
            "tags": "one, two",
        },
    ))

    assert _RecordingClient.last_request is not None
    assert _RecordingClient.last_request["json"] == {
        "title": "runtime title",
        "category": "runtime category",
        "tags": ["one", "two"],
    }
