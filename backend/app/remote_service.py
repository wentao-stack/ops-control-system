"""Detect running services on remote hosts via SSH."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from .remote import ssh_exec


@dataclass
class RemoteService:
    name: str
    service_type: str  # systemd, docker, process
    status: str  # running, stopped, unknown
    pid: str = ""
    ports: str = ""
    description: str = ""
    uptime: str = ""


# Known services to detect — expandable
KNOWN_SERVICES = {
    "frps": {"type": "reverse-proxy", "desc": "FRP Server (反向代理)"},
    "frpc": {"type": "reverse-proxy", "desc": "FRP Client"},
    "nginx": {"type": "web-server", "desc": "Nginx Web Server"},
    "caddy": {"type": "web-server", "desc": "Caddy Web Server"},
    "sshd": {"type": "ssh", "desc": "SSH Server"},
    "dockerd": {"type": "container", "desc": "Docker Daemon"},
    "containerd": {"type": "container", "desc": "Containerd Runtime"},
    "llama-server": {"type": "ai-inference", "desc": "LLaMA.cpp Server"},
    "hermes": {"type": "ai-agent", "desc": "Hermes Agent"},
    "uvicorn": {"type": "web-server", "desc": "Uvicorn ASGI Server"},
    "fail2ban": {"type": "security", "desc": "Fail2ban"},
    "redis-server": {"type": "database", "desc": "Redis"},
    "postgres": {"type": "database", "desc": "PostgreSQL"},
    "mysql": {"type": "database", "desc": "MySQL"},
    "mariadbd": {"type": "database", "desc": "MariaDB"},
    "node": {"type": "runtime", "desc": "Node.js"},
    "python": {"type": "runtime", "desc": "Python"},
    "java": {"type": "runtime", "desc": "Java"},
}


# Script to detect services — works on systemd and non-systemd systems
SERVICE_DETECT_SCRIPT = r"""
(
  echo "===SYSTEMD_SERVICES==="
  if command -v systemctl &>/dev/null; then
    systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | \
      awk '{print $1}' | sed 's/.service//' | sort
  else
    echo "(no systemctl)"
  fi

  echo "===USER_SERVICES==="
  systemctl --user list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | \
    awk '{print $1}' | sed 's/.service//' | sort

  echo "===DOCKER_CONTAINERS==="
  if command -v docker &>/dev/null; then
    docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null
  else
    echo "(no docker)"
  fi

  echo "===PROCESS_LIST==="
  ps -o pid,comm= 2>/dev/null | awk 'NR>1 {print $1, $2}' | sort -k2

  echo "===LISTENING_PORTS==="
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | awk 'NR>1 {print $4, $6}'
  elif command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | awk 'NR>2 {print $4, $NF}'
  else
    echo "(no ss/netstat)"
  fi
) 2>/dev/null
"""


def detect_remote_services(host: str, port: int, user: str, asset_id: str, name: str, timeout: int = 60) -> list[RemoteService]:
    """Detect running services on a remote host via SSH."""
    r = ssh_exec(host, port, user, SERVICE_DETECT_SCRIPT, timeout=timeout)
    if r["exit_code"] != 0:
        return []

    return _parse_service_output(r["stdout"], asset_id, name)


def _parse_service_output(output: str, asset_id: str, name: str) -> list[RemoteService]:
    """Parse the multi-section service detection output."""
    sections: dict[str, str] = {}
    current = None
    lines: list[str] = []

    for line in output.splitlines():
        if line.startswith("===") and line.endswith("==="):
            if current:
                sections[current] = "\n".join(lines)
            current = line[3:-3]
            lines = []
        else:
            lines.append(line)
    if current:
        sections[current] = "\n".join(lines)

    services: list[RemoteService] = []
    seen_names: set[str] = set()

    # Parse systemd services
    for svc_name in sections.get("SYSTEMD_SERVICES", "").strip().splitlines():
        svc_name = svc_name.strip()
        if not svc_name or svc_name == "(no systemctl)":
            continue
        # Normalize: remove instance suffix for matching (e.g. getty@tty1 -> getty)
        base_name = svc_name.split("@")[0]
        info = KNOWN_SERVICES.get(base_name)
        if info:
            services.append(RemoteService(
                name=svc_name,
                service_type=info["type"],
                status="running",
                description=info["desc"],
            ))
            seen_names.add(base_name)

    # Parse user services
    for svc_name in sections.get("USER_SERVICES", "").strip().splitlines():
        svc_name = svc_name.strip()
        if not svc_name or not svc_name:
            continue
        base_name = svc_name.split("@")[0]
        info = KNOWN_SERVICES.get(base_name)
        if info and base_name not in seen_names:
            services.append(RemoteService(
                name=svc_name,
                service_type=info["type"],
                status="running",
                description=info["desc"],
            ))
            seen_names.add(base_name)

    # Parse Docker containers
    for line in sections.get("DOCKER_CONTAINERS", "").strip().splitlines():
        if not line or line == "(no docker)":
            continue
        parts = line.split("\t")
        container_name = parts[0].strip()
        container_status = parts[1].strip() if len(parts) > 1 else ""
        container_ports = parts[2].strip() if len(parts) > 2 else ""
        services.append(RemoteService(
            name=container_name,
            service_type="docker-container",
            status="running" if "Up" in container_status else "stopped",
            ports=container_ports,
            description=f"Docker: {container_status}",
        ))

    # Parse process list — find known services not yet detected
    for line in sections.get("PROCESS_LIST", "").strip().splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        pid, comm = parts
        base_comm = comm.split("@")[0]
        info = KNOWN_SERVICES.get(base_comm)
        if info and base_comm not in seen_names:
            services.append(RemoteService(
                name=comm,
                service_type=info["type"],
                status="running",
                pid=pid,
                description=info["desc"],
            ))
            seen_names.add(base_comm)

    # Parse listening ports — attach to existing services
    port_map: dict[str, str] = {}
    for line in sections.get("LISTENING_PORTS", "").strip().splitlines():
        if not line or line == "(no ss/netstat)":
            continue
        parts = line.strip().split(None, 1)
        if parts:
            addr = parts[0]
            proc = parts[1] if len(parts) > 1 else ""
            # Extract port from addr (last colon-separated part)
            port_str = addr.rsplit(":", 1)[-1] if ":" in addr else addr
            if proc:
                proc_name = proc.strip("[]")
                for svc in services:
                    if proc_name in svc.name or svc.name in proc_name:
                        if port_str not in svc.ports:
                            svc.ports = (svc.ports + "," + port_str).strip(",")

    return services
