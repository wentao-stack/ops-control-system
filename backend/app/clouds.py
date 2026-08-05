from __future__ import annotations

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
            logger.error("Vultr API error: %s — %s", e.response.status_code, e.response.text)
            from fastapi import HTTPException
            raise HTTPException(
                status_code=502,
                detail=f"Vultr API {e.response.status_code}: {e.response.text[:200]}",
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
            "id": inst.get("ID", ""),
            "default_ip": inst.get("MAIN_IP", ""),
            "region": inst.get("REGION_ID", ""),
            "plan": inst.get("PLAN", ""),
            "status": inst.get("STATUS", ""),
            "label": inst.get("LABEL", ""),
            "hostname": inst.get("HOSTNAME", ""),
            "os": inst.get("OS", ""),
            "vcpu_count": inst.get("VCPU_COUNT", 0),
            "memory": inst.get("MEMORY", 0),
            "disk": inst.get("DISK", 0),
            "created": inst.get("DATE_CREATED", ""),
            "current_price": inst.get("CURRENT_PRICE", ""),
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
