"""Remote Supervisor process management via SSH or local subprocess.

Uses SSH to execute `supervisorctl` commands on remote hosts, or local
subprocess when the asset is the backend host itself.
Supports: status, start, stop, restart, signal, tail (logs).
"""

from __future__ import annotations

import glob
import json
import os
import re
import subprocess
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


def _local_exec(cmd: str, timeout: int = 30) -> dict:
    """Execute a command locally via subprocess (for local_machine assets)."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout,
        )
        return {
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired:
        return {"exit_code": -1, "stdout": "", "stderr": "Command timed out"}
    except Exception as e:
        return {"exit_code": -1, "stdout": "", "stderr": str(e)}


def _discover_log_local(process: str, log_type: str, conf_dir: str) -> str:
    """Discover supervisor log file path by parsing config (local version)."""
    for f in sorted(glob.glob(os.path.join(conf_dir, "*.conf"))):
        c = open(f).read()
        if f"[program:{process}]" in c:
            lf = re.search(r"stdout_logfile=(\S+)", c)
            ef = re.search(r"stderr_logfile=(\S+)", c)
            rf = re.search(r"redirect_stderr=(\S+)", c)
            redirect = rf and rf.group(1) == "true"
            if log_type == "stderr" and not redirect:
                return ef.group(1) if ef else ""
            return lf.group(1) if lf else ""
    return ""


def _read_file_tail(path: str, lines: int) -> list[str]:
    """Tail a local file, return lines."""
    try:
        with open(path) as f:
            all_lines = f.read().splitlines()
        return all_lines[-lines:] if len(all_lines) > lines else all_lines
    except (FileNotFoundError, PermissionError):
        return []


def supervisor_status(
    host: str, port: int, user: str, local_machine: bool = False, timeout: int = 30,
) -> list[SupervisorProcess]:
    """Get status of all supervisor-managed processes."""
    if local_machine:
        ctl, conf = _supervisorctl_cmd(user)
        cmd = f"{ctl} {conf} status".strip()
        r = _local_exec(cmd, timeout=timeout)
    else:
        ctl, conf = _supervisorctl_cmd(user)
        cmd = f"{ctl} {conf} status".strip()
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
    local_machine: bool = False,
    timeout: int = 30,
) -> SupervisorActionResult:
    """Execute a supervisor action (start/stop/restart/signal)."""
    ctl, conf = _supervisorctl_cmd(user)
    ctl_cmd = f"{ctl} {conf}".strip()

    if action == "signal":
        if not signal:
            return SupervisorActionResult(
                success=False, process=process,
                message="Signal name is required for 'signal' action",
            )
        cmd = f"{ctl_cmd} signal {signal} {process}"
    else:
        cmd = f"{ctl_cmd} {action} {process}"

    if local_machine:
        r = _local_exec(cmd, timeout=timeout)
    else:
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


def _get_supervisor_paths(user: str) -> tuple[str, str]:
    """Return (conf_dir, log_base) for supervisor based on user."""
    if user == "root":
        return "/etc/supervisor/conf.d", "/var/log/supervisor"
    # For non-root users, try the standard XDG/home directory locations
    home = f"/home/{user}"
    user_conf = f"{home}/.supervisor/conf.d"
    user_log = f"{home}/.supervisor/log"
    # Fall back to system paths if user-specific paths don't apply
    if user in _USER_SUP:
        return user_conf, user_log
    return "/etc/supervisor/conf.d", "/var/log/supervisor"


def supervisor_tail(
    host: str,
    port: int,
    user: str,
    process: str,
    log_type: str = "stdout",
    lines: int = 100,
    local_machine: bool = False,
    timeout: int = 30,
) -> SupervisorLogLines:
    """Tail the log output of a supervisor-managed process."""
    conf_dir, log_base = _get_supervisor_paths(user)

    # Discover supervisor log file path
    if local_machine:
        supervisor_log = _discover_log_local(process, log_type, conf_dir)
    else:
        discover_script = (
            "import glob, re, sys\n"
            "proc = sys.argv[1]\n"
            "log_type = sys.argv[2]\n"
            "conf_dir = sys.argv[3]\n"
            "for f in sorted(glob.glob(conf_dir + '/*.conf')):\n"
            "    c = open(f).read()\n"
            "    if '[program:' + proc + ']' in c:\n"
            "        lf = re.search(r'stdout_logfile=(\\S+)', c)\n"
            "        ef = re.search(r'stderr_logfile=(\\S+)', c)\n"
            "        rf = re.search(r'redirect_stderr=(\\S+)', c)\n"
            "        redirect = rf and rf.group(1) == 'true'\n"
            "        if log_type == 'stderr' and not redirect:\n"
            "            print(ef.group(1) if ef else '', end='')\n"
            "        else:\n"
            "            print(lf.group(1) if lf else '', end='')\n"
            "        break\n"
        )
        tmp = "/tmp/_sup_discover.py"
        write_cmd = f"cat > {tmp} << 'PYEOF'\n{discover_script}PYEOF"
        run_cmd = f"python3 {tmp} {process} {log_type} {conf_dir} && rm -f {tmp}"
        r = ssh_exec(host, port, user, write_cmd + " && " + run_cmd, timeout=timeout)
        supervisor_log = r["stdout"].strip()

    # Collect all log sources
    sources_to_read: list[tuple[str, str, str]] = []

    if supervisor_log:
        sources_to_read.append(("Supervisor stdout", supervisor_log, "supervisor"))

    app_logs = _APP_LOGS.get(process, [])
    for label, path in app_logs:
        sources_to_read.append((label, path, "app"))

    if not supervisor_log:
        fallbacks = (
            [f"{log_base}/{process}-error.log", f"{log_base}/{process}.log"]
            if log_type == "stderr"
            else [f"{log_base}/{process}.log"]
        )
        for fb in fallbacks:
            sources_to_read.append((f"Supervisor ({fb.split('/')[-1]})", fb, "supervisor"))

    if not sources_to_read:
        return SupervisorLogLines(process=process, lines=[], sources=[])

    # Read sources — local or remote
    sources: list[SupervisorLogFile] = []
    all_lines: list[str] = []

    if local_machine:
        for label, path, source_type in sources_to_read:
            file_lines = _read_file_tail(path, lines)
            if file_lines:
                sources.append(SupervisorLogFile(
                    source=source_type, label=label, path=path, lines=file_lines,
                ))
                all_lines.extend(file_lines)
    else:
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

        current_source: SupervisorLogFile | None = None
        for line in raw_output.splitlines():
            if line.startswith("=== ") and " ===" in line:
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
                    source=source_type, label=label, path=path, lines=[],
                )
            elif current_source is not None:
                current_source.lines.append(line)
                all_lines.append(line)

        if current_source is not None:
            sources.append(current_source)

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
    local_machine: bool = False,
    timeout: int = 30,
) -> SupervisorActionResult:
    """Reload supervisor configuration (reread + update)."""
    ctl, conf = _supervisorctl_cmd(user)
    ctl_cmd = f"{ctl} {conf}".strip()
    if local_machine:
        r = _local_exec(f"{ctl_cmd} reread && {ctl_cmd} update", timeout=timeout)
    else:
        r = ssh_exec(host, port, user, f"{ctl_cmd} reread && {ctl_cmd} update", timeout=timeout)
    success = r["exit_code"] == 0
    return SupervisorActionResult(
        success=success,
        process="config",
        message=r["stderr"].strip() if not success else "Configuration reloaded",
        stdout=r["stdout"],
        stderr=r["stderr"],
    )
