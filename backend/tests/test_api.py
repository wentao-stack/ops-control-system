from fastapi.testclient import TestClient

from app.main import app


def test_summary_and_assets_are_available():
    with TestClient(app) as client:
        summary = client.get("/api/v1/inventory/summary")
        assets = client.get("/api/v1/assets")

    assert summary.status_code == 200
    assert summary.json()["total"] == 3  # 3 real production servers
    assert assets.status_code == 200
    assert assets.json()["total"] == 3


def test_asset_detail():
    with TestClient(app) as client:
        detail = client.get("/api/v1/assets/asset-prod-vps-sanbunto")
        missing = client.get("/api/v1/assets/missing")

    assert detail.status_code == 200
    assert detail.json()["name"] == "archlinux (163.44.124.142)"
    assert missing.status_code == 404
