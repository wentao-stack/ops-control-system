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
        "id": account.get("id", ""),
        "email": account.get("email", ""),
        "status": account.get("status", ""),
        "allowed_ips": account.get("allowed_ips", []),
        "expected_charge_next_cycle": account.get("expected_charge_next_cycle", ""),
        "low_balance_threshold": account.get("low_balance_threshold", ""),
        "balance": account.get("current_balance", ""),
        "balance_paid": account.get("balance_paid", ""),
        "funding_balance": account.get("funding_balance", ""),
        "funding_pending": account.get("funding_pending", ""),
        "funding_pending_desc": account.get("funding_pending_desc", ""),
        "funding_available": account.get("funding_available", ""),
        "funding_available_desc": account.get("funding_available_desc", ""),
        "funding_low_threshold": account.get("funding_low_threshold", ""),
        "funding_low_threshold_desc": account.get("funding_low_threshold_desc", ""),
        "funding_low_threshold_enabled": account.get("funding_low_threshold_enabled", False),
        "funding_low_threshold_enabled_desc": account.get("funding_low_threshold_enabled_desc", ""),
        "funding_low_threshold_enabled_desc2": account.get("funding_low_threshold_enabled_desc2", ""),
        "funding_low_threshold_enabled_desc3": account.get("funding_low_threshold_enabled_desc3", ""),
        "funding_low_threshold_enabled_desc4": account.get("funding_low_threshold_enabled_desc4", ""),
        "funding_low_threshold_enabled_desc5": account.get("funding_low_threshold_enabled_desc5", ""),
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
            "os_id": inst.get("OS_ID", ""),
            "ram_id": inst.get("RAM_ID", ""),
            "disk_id": inst.get("DISK_ID", ""),
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
            "bandwidth": inst.get("BANDWIDTH", 0),
            "net_ipv4": inst.get("MAIN_IP", ""),
            "tags": inst.get("TAGS", []),
            "created": inst.get("DATE_CREATED", ""),
            "current_price": inst.get("CURRENT_PRICE", ""),
            "price": inst.get("PRICE", 0),
        })
    return result
