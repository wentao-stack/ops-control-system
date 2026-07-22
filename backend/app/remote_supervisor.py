"""Remote Supervisor process management via SSH.

Uses SSH to execute `supervisorctl` commands on remote hosts.
Supports: status, start, stop, restart, signal, tail (logs).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .remote import ssh_exec


@dataclass
class SupervisorProcess:
    """A single process managed by Supervisor."""
    name: str
    group: str  # empty string if no group
    display_name: str  # e.g. "nginx" or "myapp:nginx"
    status: str  # RUNNING, STOPPED, STARTING, STOPPING, FATAL, BACKOFF
    pid: int
    uptime: str = ""


@dataclass
class SupervisorActionResult:
    """Result of a supervisor action (start/stop/restart/signal)."""
    success: bool
    process: str  # process identifier
    message: str = ""
    stdout: str = ""
    stderr: str = ""


@dataclass
class SupervisorLogFile:
    """A single log source for a process."""
    source: str  # "supervisor" or app name like "nginx-access", "frps"
    label: str   # human-readable label
    path: str    # file path on remote host
    lines: list[str] = field(default_factory=list)


@dataclass
class SupervisorLogLines:
    """Tail output from a supervisor process log."""
    process: str
    lines: list[str] = field(default_factory=list)
    truncated: bool = False
    # Multiple log sources (when app has its own logs)
    sources: list[SupervisorLogFile] = field(default_factory=list)


# ── Status parsing ────────────────────────────────────────────────────────────

# RUNNING/STARTING/STOPPING: "name  STATUS  pid N,  uptime ..."
_STATUS_RE = re.compile(
    r"^(?P<name>\S+)\s+"
    r"(?P<status>\S+)\s+"
    r"pid\s+(?P<pid>\d+),"
    r"\s+uptime\s+(?P<uptime>.+)$"
)

# STOPPED/FATAL/BACKOFF: "name  STATUS  <date/time or extra info>"
# Examples:
#   nginx           STOPPED   Jul 22 04:14 PM
#   myapp           FATAL     Jun 01 10:30 AM
#   worker          BACKOFF   06:23AM
_STATUS_NO_PID_RE = re.compile(
    r"^(?P<name>\S+)\s+"
    r"(?P<status>\S+)"
)


def _parse_status_output(stdout: str) -> list[SupervisorProcess]:
    """Parse `supervisorctl status` output into structured data."""
    processes: list[SupervisorProcess] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue

        m = _STATUS_RE.match(line)
        if m:
            name = m.group("name")
            group, proc = (name.split(":", 1) if ":" in name else ("", name))
            processes.append(SupervisorProcess(
                name=proc,
                group=group,
                display_name=name,
                status=m.group("status"),
                pid=int(m.group("pid")),
                uptime=m.group("uptime"),
            ))
            continue

        m2 = _STATUS_NO_PID_RE.match(line)
        if m2:
            name = m2.group("name")
            group, proc = (name.split(":", 1) if ":" in name else ("", name))
            processes.append(SupervisorProcess(
                name=proc,
                group=group,
                display_name=name,
                status=m2.group("status"),
                pid=0,
                uptime="",
            ))

    return processes


# ── Public API ────────────────────────────────────────────────────────────────

# Per-user supervisorctl path and config overrides.
# Root users on Arch/Alpine use system paths; regular users use ~/.local/.
_USER_SUP: dict[str, tuple[str, str]] = {
    "root": ("supervisorctl", ""),
    "wentao": ("/home/wentao/.local/bin/supervisorctl", "-c /home/wentao/.supervisor/supervisord.conf"),
}


def _supervisorctl_cmd(user: str) -> tuple[str, str]:
    """Return (supervisorctl_path, config_flag) for a given SSH user."""
    return _USER_SUP.get(user, ("supervisorctl", ""))


def supervisor_status(
    host: str, port: int, user: str, timeout: int = 30,
) -> list[SupervisorProcess]:
    """Get status of all supervisor-managed processes on a remote host."""
    ctl, conf = _supervisorctl_cmd(user)
    cmd = f"{ctl} status"
    r = ssh_exec(host, port, user, cmd, timeout=timeout)
    if not r["stdout"].strip():
        return []
    return _parse_status_output(r["stdout"])


def supervisor_action(
    host: str,
    port: int,
    user: str,
    action: str,       # start | stop | restart | signal
    process: str,      # process name or "all"
    signal: str = "",  # only for action=signal, e.g. "HUP"
    timeout: int = 30,
) -> SupervisorActionResult:
    """Execute a supervisor action on a remote host.

    Actions: start, stop, restart, signal
    Process: process name (e.g. "nginx"), group:process, or "all"
    Signal: signal name for action=signal (e.g. "HUP", "USR1")
    """
    ctl, _ = _supervisorctl_cmd(user)

    if action == "signal":
        if not signal:
            return SupervisorActionResult(
                success=False, process=process,
                message="Signal name is required for 'signal' action",
            )
        cmd = f"{ctl} signal {signal} {process}"
    else:
        cmd = f"{ctl} {action} {process}"

    r = ssh_exec(host, port, user, cmd, timeout=timeout)
    success = r["exit_code"] == 0
    msg = ""
    if not success and r["stderr"]:
        msg = r["stderr"].strip()
    elif not success and r["stdout"]:
        msg = r["stdout"].strip()

    return SupervisorActionResult(
        success=success,
        process=process,
        message=msg,
        stdout=r["stdout"],
        stderr=r["stderr"],
    )


# ── Known application log paths ──────────────────────────────────────────────
# Maps process name → list of (label, path_pattern) for app-specific logs
_APP_LOGS: dict[str, list[tuple[str, str]]] = {
    "nginx": [
        ("Nginx Access", "/var/log/nginx/access.log"),
        ("Nginx Error", "/var/log/nginx/error.log"),
    ],
    "frps": [
        ("FRP Server", "/var/log/frps.log"),
    ],
    "fail2ban": [
        ("Fail2ban", "/var/log/fail2ban.log"),
    ],
}


def supervisor_tail(
    host: str,
    port: int,
    user: str,
    process: str,
    log_type: str = "stdout",  # stdout | stderr | all
    lines: int = 100,
    timeout: int = 30,
) -> SupervisorLogLines:
    """Tail the log output of a supervisor-managed process.

    Discovers log sources:
    1. Supervisor stdout_logfile / stderr_logfile from config
    2. Application-specific log files (nginx, frps, fail2ban, etc.)

    log_type: 'stdout', 'stderr', or 'all' (default: 'all' to get everything)
    """
    # Step 1: discover supervisor log file path from config
    ctl, conf = _supervisorctl_cmd(user)
    # Determine config dir based on user
    conf_dir = "/home/wentao/.supervisor/conf.d" if user == "wentao" else "/etc/supervisor/conf.d"

    discover_py = (
        "import glob, re\\\\n"
        f"proc = '{process}'\\\\n"
        f"log_type = '{log_type}'\\\\n"
        f"conf_dir = '{conf_dir}'\\\\n"
        "for f in sorted(glob.glob(conf_dir + '/*.conf')):\\\\n"
        "    c = open(f).read()\\\\n"
        "    if '[program:' + proc + ']' in c:\\\\n"
        "        lf = re.search(r'stdout_logfile=(\\\\\\\\S+)', c)\\\\n"
        "        ef = re.search(r'stderr_logfile=(\\\\\\\\S+)', c)\\\\n"
        "        rf = re.search(r'redirect_stderr=(\\\\\\\\S+)', c)\\\\n"
        "        redirect = rf and rf.group(1) == 'true'\\\\n"
        "        stdout = lf.group(1) if lf else ''\\\\n"
        "        stderr = ef.group(1) if ef else ''\\\\n"
        "        if log_type == 'stderr' and not redirect:\\\\n"
        "            print(stderr, end='')\\\\n"
        "        else:\\\\n"
        "            print(stdout, end='')\\\\n"
        "        break\\\\n"
    )
    r = ssh_exec(host, port, user, f"python3 -c '{discover_py}'", timeout=timeout)
    supervisor_log = r["stdout"].strip()

    # Step 2: collect all log sources to read
    sources_to_read: list[tuple[str, str, str]] = []  # (label, path, source_type)

    # Supervisor log
    if supervisor_log:
        sources_to_read.append(("Supervisor stdout", supervisor_log, "supervisor"))

    # Application-specific logs
    app_logs = _APP_LOGS.get(process, [])
    for label, path in app_logs:
        sources_to_read.append((label, path, "app"))

    # Fallback supervisor paths if no config found
    if not supervisor_log:
        fallbacks = (
            [f"/var/log/supervisor/{process}.stderr.log", f"/var/log/supervisor/{process}.log"]
            if log_type == "stderr"
            else [f"/var/log/supervisor/{process}.stdout.log", f"/var/log/supervisor/{process}.log"]
        )
        for fb in fallbacks:
            sources_to_read.append((f"Supervisor ({fb.split('/')[-1]})", fb, "supervisor"))

    # Step 3: read all sources in one SSH call
    if not sources_to_read:
        return SupervisorLogLines(process=process, lines=[], sources=[])

    # Build a single command that reads all sources with headers
    read_parts: list[str] = []
    for label, path, _ in sources_to_read:
        read_parts.append(
            f"echo '=== {label} ({path}) ==='; "
            f"tail -n {lines} '{path}' 2>/dev/null || echo '(file not found)'; "
            f"echo '';"
        )
    read_cmd = " ".join(read_parts)

    r = ssh_exec(host, port, user, read_cmd, timeout=timeout)
    raw_output = r["stdout"]

    # Step 4: parse output into sources
    sources: list[SupervisorLogFile] = []
    all_lines: list[str] = []

    # Split by source headers
    current_source: SupervisorLogFile | None = None
    for line in raw_output.splitlines():
        if line.startswith("=== ") and " ===" in line:
            # Parse header: "=== Label (path) ==="
            header = line[4:-4].strip()
            paren_idx = header.rindex("(")
            label = header[:paren_idx].strip()
            path = header[paren_idx + 1:-1].strip()
            source_type = "app" if current_source is None else (
                "app" if "Supervisor" not in label else "supervisor"
            )
            if current_source is not None:
                sources.append(current_source)
            current_source = SupervisorLogFile(
                source=source_type,
                label=label,
                path=path,
                lines=[],
            )
        elif current_source is not None:
            current_source.lines.append(line)
            all_lines.append(line)

    if current_source is not None:
        sources.append(current_source)

    # Filter out empty sources (file not found)
    sources = [s for s in sources if s.lines and s.lines[0] != "(file not found)"]

    return SupervisorLogLines(
        process=process,
        lines=all_lines,
        sources=sources,
    )


def supervisor_reread(
    config: str = "",
    host: str = "",
    port: int = 0,
    user: str = "",
    timeout: int = 30,
) -> SupervisorActionResult:
    """Reload supervisor configuration (reread + update)."""
    ctl, _ = _supervisorctl_cmd(user)
    r = ssh_exec(host, port, user, f"{ctl} reread && {ctl} update", timeout=timeout)
    success = r["exit_code"] == 0
    return SupervisorActionResult(
        success=success,
        process="config",
        message=r["stderr"].strip() if not success else "Configuration reloaded",
        stdout=r["stdout"],
        stderr=r["stderr"],
    )
