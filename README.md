# Ops Control System

SQLite-first development implementation of the Server Inventory Dashboard v0.

## Scope

- Read-only inventory dashboard with sanitized development data.
- FastAPI API and SQLite persistence.
- React + TypeScript user interface.
- No Redis, authentication, remote host access, production data, or mutation API.

## Local development

Backend (Python 3.12+):

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Frontend (Node.js 20+):

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite development server proxies `/api` to the API.

## Tests

```bash
cd backend
python3 -m pytest
```

The SQLite database is created locally at `backend/.data/ops-dev.db` and is intentionally ignored by Git.

## Controlled service activation

`deploy/systemd/ops-control-system.service` runs the built Dashboard only on
`127.0.0.1:18080`. `deploy/frp/ops-control-system.toml` is a credential-free
proxy fragment for `ops.sanbunto.online`.

An operator must not install or restart the service/FRP proxy until the related
server-side task has verified DNS, TLS, FRPS routing, rollback, and an FRP token
rotation. No credential belongs in this repository.
