from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime

import httpx

logger = logging.getLogger(__name__)

VULTR_API_BASE = "https://api.vultr.com/v2"


async def fetch_vultr_account() -> dict:
    """Call Vultr API GET /account and return parsed JSON.

    Reads VULTR_API_KEY from environment.
    Raises HTTPException 502 if key is missing or API call fails.
    """
    api_key = os.environ.get("VULTR_API_KEY", "").strip()
    if not api_key:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail="VULTR_API_KEY not configured")

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.get(
                f"{VULTR_API_BASE}/account",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            body = e.response.text[:200]
            if e.response.status_code == 401 and "Unauthorized IP" in body:
                logger.warning("Vultr API IP whitelist blocked — add server IP to Vultr whitelist")
                from fastapi import HTTPException
                raise HTTPException(
                    status_code=502,
                    detail="Vultr API IP 白名單限制 — 請在 Vultr 後台將伺服器 IP 加入白名單",
                )
            logger.error("Vultr API error: %s — %s", e.response.status_code, body)
            from fastapi import HTTPException
            raise HTTPException(
                status_code=502,
                detail=f"Vultr API {e.response.status_code}: {body}",
            )
        except httpx.RequestError as e:
            logger.error("Vultr API request failed: %s", e)
            from fastapi import HTTPException
            raise HTTPException(status_code=502, detail=f"Vultr API request failed: {e}")

    data = resp.json()
    account = data.get("account", {})

    return {
        "name": account.get("name", ""),
        "email": account.get("email", ""),
        "org_name": account.get("org_name", ""),
        "country": account.get("country", ""),
        "balance": str(account.get("balance", "")),
        "pending_charges": str(account.get("pending_charges", "")),
        "prepayment_remaining": account.get("prepayment_remaining", ""),
        "last_payment_date": account.get("last_payment_date", ""),
        "last_payment_amount": str(account.get("last_payment_amount", "")),
        "remaining_credit": str(round(abs(float(account.get("balance", 0))) - float(account.get("pending_charges", 0)), 2)),
        "fetched_at": datetime.now().isoformat(),
    }


async def fetch_vultr_instances() -> list[dict]:
    """Call Vultr API GET /instances and return simplified list."""
    api_key = os.environ.get("VULTR_API_KEY", "").strip()
    if not api_key:
        return []

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.get(
                f"{VULTR_API_BASE}/instances",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
        except Exception as e:
            logger.error("Vultr instances API error: %s", e)
            return []

    data = resp.json()
    instances = data.get("instances", [])

    result = []
    for inst in instances:
        result.append({
            "id": inst.get("id", ""),
            "default_ip": inst.get("main_ip", ""),
            "region": inst.get("region", ""),
            "plan": inst.get("plan", ""),
            "status": inst.get("status", ""),
            "label": inst.get("label", ""),
            "hostname": inst.get("hostname", ""),
            "os": inst.get("os", ""),
            "vcpu_count": inst.get("vcpu_count", 0),
            "memory": inst.get("ram", 0),
            "disk": inst.get("disk", 0),
            "created": inst.get("date_created", ""),
            "current_price": inst.get("current_price", ""),
        })
    return result


async def fetch_vultr_billing_history() -> list[dict]:
    """Call Vultr API GET /billing/history and return recent billing records."""
    api_key = os.environ.get("VULTR_API_KEY", "").strip()
    if not api_key:
        return []

    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get(
                f"{VULTR_API_BASE}/billing/history",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
        except Exception as e:
            logger.error("Vultr billing history API error: %s", e)
            return []

    data = resp.json()
    history = data.get("billing_history", [])

    result = []
    for item in history[:20]:  # 最近 20 筆
        result.append({
            "id": item.get("id", ""),
            "date": item.get("date", ""),
            "type": item.get("type", ""),
            "description": item.get("description", ""),
            "amount": item.get("amount", 0),
            "balance": item.get("balance", 0),
            "status": item.get("status", ""),
        })
    return result


# ── ConoHa VPS 3.0 (OpenStack Nova) ──────────────────────────────────────────

CONOHA_IDENTITY_URL = os.environ.get("CONOHA_IDENTITY_URL", "https://identity.c3j1.conoha.io/v3/auth/tokens")
CONOHA_COMPUTE_URL = os.environ.get("CONOHA_COMPUTE_URL", "https://compute.c3j1.conoha.io/v2.1")

# Token cache: (token, expiry_timestamp)
_conoha_token_cache: tuple[str, float] | None = None


async def _get_conoha_token() -> str:
    """Authenticate with ConoHa Keystone v3 and return a valid token.

    Caches token until ~5 min before expiry (tokens are valid 24h).
    """
    global _conoha_token_cache

    user_id = os.environ.get("CONOHA_USER_ID", "").strip()
    password = os.environ.get("CONOHA_PASSWORD", "").strip()
    tenant_id = os.environ.get("CONOHA_TENANT_ID", "").strip()

    if not all([user_id, password, tenant_id]):
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail="ConoHa credentials not configured (CONOHA_USER_ID/PASSWORD/TENANT_ID)")

    # Return cached token if still valid
    if _conoha_token_cache:
        token, expiry = _conoha_token_cache
        if datetime.now().timestamp() < expiry:
            return token

    payload = {
        "auth": {
            "identity": {
                "methods": ["password"],
                "password": {
                    "user": {
                        "id": user_id,
                        "password": password,
                    }
                },
            },
            "scope": {
                "project": {"id": tenant_id}
            },
        }
    }

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.post(
                CONOHA_IDENTITY_URL,
                json=payload,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error("ConoHa auth error: %s — %s", e.response.status_code, e.response.text)
            from fastapi import HTTPException
            raise HTTPException(
                status_code=502,
                detail=f"ConoHa auth {e.response.status_code}: {e.response.text[:200]}",
            )
        except httpx.RequestError as e:
            logger.error("ConoHa auth request failed: %s", e)
            from fastapi import HTTPException
            raise HTTPException(status_code=502, detail=f"ConoHa auth request failed: {e}")

    token = resp.headers.get("x-subject-token", "")
    if not token:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail="ConoHa auth returned no token")

    # Cache for 23h (token valid 24h, expire 1h early for safety)
    _conoha_token_cache = (token, datetime.now().timestamp() + 23 * 3600)
    return token


async def fetch_conoha_instances() -> list[dict]:
    """Call ConoHa Compute API GET /servers/detail and return simplified list."""
    token = await _get_conoha_token()

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            # Fetch servers and flavors in parallel
            resp_servers, resp_flavors = await asyncio.gather(
                client.get(
                    f"{CONOHA_COMPUTE_URL}/servers/detail",
                    headers={"X-Auth-Token": token, "Accept": "application/json"},
                ),
                client.get(
                    f"{CONOHA_COMPUTE_URL}/flavors",
                    headers={"X-Auth-Token": token, "Accept": "application/json"},
                ),
            )
            resp_servers.raise_for_status()
            resp_flavors.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error("ConoHa API error: %s — %s", e.response.status_code, e.response.text)
            return []
        except httpx.RequestError as e:
            logger.error("ConoHa request failed: %s", e)
            return []

    # Build flavor ID -> name map
    flavor_map: dict[str, str] = {}
    for f in resp_flavors.json().get("flavors", []):
        fid = f.get("id", "")
        fname = f.get("name", "")
        if fid and fname:
            flavor_map[fid] = fname

    servers = resp_servers.json().get("servers", [])

    result = []
    for srv in servers:
        # Extract first IPv4 address from addresses
        addresses = srv.get("addresses", {})
        first_ip = ""
        for network_addrs in addresses.values():
            if isinstance(network_addrs, list) and network_addrs:
                for addr_entry in network_addrs:
                    if addr_entry.get("version") == 4:
                        first_ip = addr_entry.get("addr", "")
                        break
                if first_ip:
                    break
                # Fallback: take first entry
                first_ip = network_addrs[0].get("addr", "")
                break

        # Extract flavor name from map
        flavor = srv.get("flavor", {}) or {}
        flavor_id = flavor.get("id", "") if isinstance(flavor, dict) else ""
        flavor_name = flavor_map.get(flavor_id, "")

        # Extract OS from image (may be empty string for ConoHa)
        image = srv.get("image", {}) or {}
        os_name = ""
        if isinstance(image, dict):
            os_name = image.get("name", "")
        elif isinstance(image, str) and image:
            os_name = image

        result.append({
            "id": srv.get("id", ""),
            "name": srv.get("name", ""),
            "default_ip": first_ip,
            "region": "c3j1",
            "plan": flavor_name,
            "status": srv.get("status", ""),
            "label": "",
            "hostname": "",
            "os": os_name,
            "vcpu_count": 0,
            "memory": 0,
            "disk": 0,
            "created": srv.get("created", ""),
            "current_price": "",
        })
    return result
