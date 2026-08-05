#!/usr/bin/env python3
import os, httpx, asyncio, json

def get_key():
    for line in open('backend/.env'):
        if line.startswith('VULTR_API_KEY'):
            return line.strip().split('=', 1)[1]
    return ''

async def test():
    key = get_key()
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get('https://api.vultr.com/v2/billing/history', headers={'Authorization': f'Bearer {key}'})
        data = r.json()
        items = data['billing_history']
        
        # Show all unique types
        types = set(item['type'] for item in items)
        print(f"Types: {types}")
        
        # Show non-invoice items
        print("\n=== Non-invoice items ===")
        for item in items:
            if item['type'] != 'invoice':
                print(json.dumps(item, indent=2))
                print('---')
        
        # Show latest invoice balance
        print(f"\n=== Latest balance from history: {items[0]['balance']} ===")

asyncio.run(test())
