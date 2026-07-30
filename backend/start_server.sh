#!/bin/bash
cd /home/wentao/project/ops-control-system/backend
source .venv/bin/activate
exec python -m uvicorn app.main:app --host 127.0.0.1 --port 18080
