# Ops Control System

Remote server operations control platform — inventory, monitoring, SSH execution, and process management.

## Architecture

- **Backend**: FastAPI + SQLAlchemy + SQLite (local dev)
- **Frontend**: React + TypeScript + Vite
- **Authentication**: JWT (bcrypt password hashing, python-jose)
- **Remote access**: SSH via paramiko (command exec, metrics, service detection)
- **Process management**: Supervisor remote control over SSH
- **Web terminal**: WebSocket-based interactive SSH terminal

## Features

### Inventory & Dashboard
- Server asset management with health status, environment, criticality
- Inventory summary with breakdowns by health and environment
- Asset detail view with associated services

### Remote Operations
- **SSH command execution**: Run commands on remote hosts via SSH
- **Host ping**: Batch ping all SSH-configured assets
- **Host metrics**: Collect CPU, memory, disk, GPU metrics from remote hosts via `/proc`
- **Service detection**: Detect running services (systemd) on remote hosts

### Supervisor Process Management
- View supervisor process status across all managed hosts
- Start/stop/restart/signal supervisor-managed processes
- Tail stdout/stderr logs from supervisor processes

### Web SSH Terminal
- Interactive SSH terminal via WebSocket (`/ws/ssh/{asset_id}`)
- Supports terminal resize (cols/rows)

### Alerts, Changes & Runbooks
- Alert listing with severity filtering and acknowledgment tracking
- Change log with type and status filtering
- Runbook library with categorization

## Project Structure

```
backend/
  app/
    main.py            # FastAPI app, all API routes
    auth.py            # JWT auth, password hashing
    database.py        # SQLAlchemy engine, session factory
    models.py          # ORM models (Asset, User, Alert, Change, Runbook, etc.)
    schemas.py         # Pydantic request/response schemas
    seed.py            # Development data seeding
    remote.py          # SSH command execution, ping (paramiko)
    remote_monitor.py  # Remote host metrics collection via /proc
    remote_service.py  # Remote service detection (systemd)
    remote_supervisor.py  # Supervisor process management over SSH
    monitor.py         # Local host metrics collection (/proc, psutil)
    webssh.py          # WebSocket SSH terminal handler
  tests/
    test_api.py        # API tests

frontend/
  src/
    pages/
      OverviewPage.tsx       # Dashboard overview
      AssetsPage.tsx         # Asset inventory list
      AssetDetailPage.tsx    # Asset detail with services
      MonitoringPage.tsx     # Host metrics dashboard
      ServicesPage.tsx       # Service status across hosts
      RemotePage.tsx         # SSH command execution
      SettingsPage.tsx       # User/settings
    components/
      WebTerminal.tsx        # WebSocket SSH terminal component
    AuthProvider.tsx         # Auth context
    auth.ts                  # Auth utilities
    LoginPage.tsx            # Login page
    Layout.tsx               # App layout with navigation
    types.ts                 # TypeScript type definitions

deploy/
  systemd/ops-control-system.service
  frp/ops-control-system.toml
```

## Quick Start

All services are managed by Supervisor under `supervisor/`. One command starts everything:

```bash
# Start (or restart) all services
./backend/.venv/bin/supervisord -c supervisor/supervisord.conf

# Check status
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf status

# Restart a single service
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-backend
./backend/.venv/bin/supervisorctl -c supervisor/supervisord.conf restart ocs-frontend
```

Services:
- **ocs-backend** — FastAPI on `127.0.0.1:18080`
- **ocs-frontend** — Vite dev server on `127.0.0.1:5173`

Open `http://127.0.0.1:5173`. The Vite dev server proxies `/api` and `/ws` to the backend.

### First-time setup

```bash
# Backend
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
pip install supervisor        # project-level supervisor lives here

# Frontend
cd frontend
npm install
```

### Manual dev mode (without Supervisor)

Backend:

```bash
cd backend
. .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 18080
```

Frontend:

```bash
cd frontend
npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | Health check |
| POST | `/api/v1/auth/login` | JWT login |
| GET | `/api/v1/auth/me` | Current user info |
| GET | `/api/v1/inventory/summary` | Inventory summary |
| GET | `/api/v1/assets` | List assets (filterable, paginated) |
| GET | `/api/v1/assets/{id}` | Asset detail with services |
| GET | `/api/v1/alerts` | List alerts |
| GET | `/api/v1/changes` | List changes |
| GET | `/api/v1/runbooks` | List runbooks |
| POST | `/api/v1/remote/exec` | Execute command on remote host |
| POST | `/api/v1/remote/ping` | Ping all remote hosts |
| GET | `/api/v1/host/metrics` | Local host metrics |
| GET | `/api/v1/hosts/metrics` | All remote host metrics |
| GET | `/api/v1/hosts/services` | All remote host services |
| GET | `/api/v1/supervisor/status` | All supervisor process status |
| POST | `/api/v1/supervisor/action` | Supervisor process action |
| POST | `/api/v1/supervisor/tail` | Tail supervisor process logs |
| WS | `/ws/ssh/{asset_id}` | Interactive SSH terminal |

## Tests

```bash
cd backend
python3 -m pytest
```

The SQLite database is created locally at `backend/.data/ops-dev.db` and is intentionally ignored by Git.

## Deployment

`deploy/systemd/ops-control-system.service` runs the application on
`127.0.0.1:18080`. `deploy/frp/ops-control-system.toml` is a credential-free
proxy fragment for `ops.sanbunto.online`.

An operator must not install or restart the service/FRP proxy until the related
server-side task has verified DNS, TLS, FRPS routing, rollback, and an FRP token
rotation. No credential belongs in this repository.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPS_SECRET_KEY` | `dev-secret-key-change-in-production` | JWT signing key |
| `OPS_TOKEN_EXPIRE_MINUTES` | `1440` (24h) | JWT token expiration |
