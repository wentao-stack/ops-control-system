#!/usr/bin/env python3
import os, httpx, asyncio

def get_key():
    for line in open('backend/.env'):
        if line.startswith('VULTR_API_KEY'):
            return line.strip().split('=', 1)[1]
    return ''

async def test():
    key = get_key()
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get('https://api.vultr.com/v2/account/balance', headers={'Authorization': f'Bearer {key}'})
        print(f"balance endpoint: {r.status_code} -> {r.text[:500]}")
        
        r2 = await client.get('https://api.vultr.com/v2/account/details', headers={'Authorization': f'Bearer {key}'})
        print(f"details endpoint: {r2.status_code} -> {r2.text[:500]}")
        
        r3 = await client.get('https://api.vultr.com/v2/billing', headers={'Authorization': f'Bearer {key}'})
        print(f"billing endpoint: {r3.status_code} -> {r3.text[:500]}")
        
        r4 = await client.get('https://api.vultr.com/v2/billing/credits', headers={'Authorization': f'Bearer {key}'})
        print(f"credits endpoint: {r4.status_code} -> {r4.text[:500]}")
        
        r5 = await client.get('https://api.vultr.com/v2/billing/invoices', headers={'Authorization': f'Bearer {key}'})
        print(f"invoices endpoint: {r5.status_code} -> {r5.text[:500]}")

asyncio.run(test())
