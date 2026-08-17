# OPS Control System — Compact Agent Rules

Scope: work only in `/home/wentao/project/ops-control-system` unless the task explicitly says otherwise. This is a FastAPI + SQLAlchemy/SQLite(WAL) backend (`backend/`, :18080) and React/Vite frontend (`frontend/`, :5173). Production serves `frontend/dist` through the backend; public URL: `https://ops.sanbunto.online`.

## Default workflow

1. Inspect narrowly: use `search_files`, then read only the relevant symbols/sections.
2. Make the smallest correct patch. Never overwrite existing source files wholesale.
3. Verify only the affected surface:
   - frontend change: `cd frontend && npx tsc --noEmit && npm run build`
   - backend change: `cd backend && python3 -m pytest` (or the focused test)
4. Commit completed changes without asking: `git add -A && git commit -m "<type>: <summary>"` (`feat|fix|docs|refactor|chore`).
5. When deployment is requested, restart with `./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-backend ocs-frontend`, then verify the public URL returns HTTP 200.

## Project rules

- Frontend API calls use `api` from `frontend/src/auth`; do not introduce axios or raw fetch.
- New frontend pages require a route in `frontend/src/main.tsx`, a navigation item in `frontend/src/Layout.tsx`, and shared types in `frontend/src/types.ts` when applicable.
- Backend routes belong in `backend/app/main.py`; schemas in `backend/app/schemas.py`; models in `backend/app/models.py`.
- Never commit secrets or read `backend/.env` into prompts.
- For module-specific conventions, call `skill_view` for `ops-control-system-dev` only when needed; do not preload large project documentation.

## Compact task format

Use one line whenever possible:

`<action> | <target/path> | <acceptance check>`

Examples:

- `fix | backend/app/remote_monitor.py timeout handling | focused pytest passes`
- `add | frontend asset-filter UI | tsc + production build pass`
- `inspect | supervisor service restart failures | report cause, no changes`

If a constraint matters, append `| constraint: ...`. The agent should infer routine project details from these rules and ask only when a material choice is missing.
