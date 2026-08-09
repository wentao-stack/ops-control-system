#!/usr/bin/env python3
"""ComfyUI 頁面端到端測試 — 登入 → 狀態/模板 → 生成 → SSE → 輸出。"""
import asyncio
import json
import sys
import time

import httpx

BASE = "http://127.0.0.1:18080"


def login() -> str:
    r = httpx.post(f"{BASE}/api/v1/auth/login", data={"username": "admin", "password": "admin123"})
    r.raise_for_status()
    return r.json()["access_token"]


def main() -> int:
    token = login()
    h = {"Authorization": f"Bearer {token}"}

    # 1. status
    r = httpx.get(f"{BASE}/api/v1/comfyui/status", headers=h, timeout=30)
    r.raise_for_status()
    st = r.json()
    print("[status]", json.dumps({k: st[k] for k in ("online", "comfyui_version", "queue_running", "queue_pending")}, ensure_ascii=False))
    if not st["online"]:
        print("FATAL: ComfyUI offline:", st.get("error"))
        return 1

    # 2. workflows
    r = httpx.get(f"{BASE}/api/v1/comfyui/workflows", headers=h, timeout=30)
    r.raise_for_status()
    tpls = r.json()["templates"]
    print("[workflows]", [(t["id"], t["name"], [p["key"] for p in t["params"]]) for t in tpls])
    if not tpls:
        print("FATAL: no templates")
        return 1

    # 3. generate (小尺寸快速測試)
    body = {
        "workflow_id": "h3_t2va",
        "params": {
            "prompt": "A short test clip of ocean waves crashing on a rocky shore at sunset, gentle synchronized wave sounds, no music.",
            "width": 640,
            "height": 384,
            "length": 48,
            "steps": 4,
            "seed": -1,
        },
    }
    r = httpx.post(f"{BASE}/api/v1/comfyui/generate", headers=h, json=body, timeout=60)
    print("[generate]", r.status_code, r.text[:200])
    if r.status_code != 200:
        return 1
    job = r.json()
    job_id, prompt_id = job["job_id"], job["prompt_id"]
    print(f"[job] id={job_id} prompt_id={prompt_id}")

    # 4. SSE 進度 (最多等 240s)
    print("[sse] streaming...")
    events = []
    try:
        with httpx.stream("GET", f"{BASE}/api/v1/comfyui/jobs/{job_id}/events", headers=h, timeout=httpx.Timeout(240, connect=10)) as resp:
            resp.raise_for_status()
            buf = ""
            for chunk in resp.iter_text():
                buf += chunk
                while "\n\n" in buf:
                    ev_raw, buf = buf.split("\n\n", 1)
                    for line in ev_raw.split("\n"):
                        if line.startswith("data: "):
                            try:
                                ev = json.loads(line[6:])
                            except json.JSONDecodeError:
                                continue
                            events.append(ev)
                            e = ev.get("event")
                            if e in ("progress",):
                                print(f"  progress {ev.get('value')}/{ev.get('max')}")
                            else:
                                print(f"  {e} {json.dumps(ev, ensure_ascii=False)[:160]}")
                            if e in ("done", "error"):
                                buf = ""
                                break
    except httpx.TimeoutException:
        print("SSE timeout")
        return 1

    if not events or events[-1]["event"] not in ("done", "error"):
        print("FATAL: SSE 未正常結束")
        return 1
    print("[sse] done, events:", len(events))

    # 5. job detail → outputs
    r = httpx.get(f"{BASE}/api/v1/comfyui/jobs/{job_id}", headers=h, timeout=30)
    r.raise_for_status()
    jd = r.json()
    print("[job-detail]", json.dumps({"status": jd["status"], "progress": jd["progress"], "error": jd["error"], "outputs": jd["outputs"]}, ensure_ascii=False))

    # 6. view 代理
    if jd["outputs"]:
        o = jd["outputs"][0]
        r = httpx.get(
            f"{BASE}/api/v1/comfyui/view",
            headers=h,
            params={"filename": o["filename"], "subfolder": o.get("subfolder", ""), "type": o.get("type", "output")},
            timeout=60,
        )
        print(f"[view] {r.status_code} content-type={r.headers.get('content-type')} bytes={len(r.content)}")

    # 7. SSE 回放（已完成任務）
    r = httpx.get(f"{BASE}/api/v1/comfyui/jobs/{job_id}/events", headers=h, timeout=30)
    print("[replay] status=", r.status_code, "body=", r.text[:120].replace("\n", "\\n"))

    # 8. jobs 列表
    r = httpx.get(f"{BASE}/api/v1/comfyui/jobs?limit=5", headers=h, timeout=30)
    r.raise_for_status()
    jobs = r.json()["jobs"]
    print("[jobs]", [(j["id"], j["workflow_name"], j["status"], len(j["outputs"])) for j in jobs])

    print("\n=== ALL OK ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
