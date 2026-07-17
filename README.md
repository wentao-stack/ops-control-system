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
