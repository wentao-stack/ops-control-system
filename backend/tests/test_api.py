from fastapi.testclient import TestClient

from app.main import app


def test_summary_and_assets_are_available():
    with TestClient(app) as client:
        summary = client.get("/api/v1/inventory/summary")
        assets = client.get("/api/v1/assets?environment=development")

    assert summary.status_code == 200
    assert summary.json()["total"] == 6
    assert summary.json()["by_health"]["critical"] == 1
    assert assets.status_code == 200
    assert assets.json()["total"] == 2


def test_asset_detail_and_missing_asset():
    with TestClient(app) as client:
        detail = client.get("/api/v1/assets/asset-dev-api-01")
        missing = client.get("/api/v1/assets/missing")

    assert detail.status_code == 200
    assert detail.json()["services"][0]["name"] == "inventory-api"
    assert missing.status_code == 404
