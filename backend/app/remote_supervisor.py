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
class SupervisorLogLines:
    """Tail output from a supervisor process log."""
    process: str
    lines: list[str] = field(default_factory=list)
    truncated: bool = False


# ── Status parsing ────────────────────────────────────────────────────────────

_STATUS_RE = re.compile(
    r"^(?P<name>\S+)\s+"
    r"(?P<status>\S+)\s+"
    r"pid\s+(?P<pid>\d+),"
    r"\s+uptime\s+(?P<uptime>.+)$"
)

# Fallback for error states (no PID/uptime)
_STATUS_ERROR_RE = re.compile(
    r"^(?P<name>\S+)\s+"
    r"(?P<status>\S+)$"
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
            # name can be "group:process" or just "process"
            if ":" in name:
                group, proc = name.split(":", 1)
            else:
                group, proc = "", name
            processes.append(SupervisorProcess(
                name=proc,
                group=group,
                display_name=name,
                status=m.group("status"),
                pid=int(m.group("pid")),
                uptime=m.group("uptime"),
            ))
            continue

        m2 = _STATUS_ERROR_RE.match(line)
        if m2:
            name = m2.group("name")
            if ":" in name:
                group, proc = name.split(":", 1)
            else:
                group, proc = "", name
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


def supervisor_status(
    host: str, port: int, user: str, timeout: int = 30,
) -> list[SupervisorProcess]:
    """Get status of all supervisor-managed processes on a remote host."""
    r = ssh_exec(host, port, user, "supervisorctl status", timeout=timeout)
    if r["exit_code"] != 0:
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
    if action == "signal":
        if not signal:
            return SupervisorActionResult(
                success=False, process=process,
                message="Signal name is required for 'signal' action",
            )
        cmd = f"supervisorctl signal {signal} {process}"
    else:
        cmd = f"supervisorctl {action} {process}"

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


def supervisor_tail(
    host: str,
    port: int,
    user: str,
    process: str,
    log_type: str = "stdout",  # stdout | stderr
    lines: int = 100,
    timeout: int = 30,
) -> SupervisorLogLines:
    """Tail the log output of a supervisor-managed process.

    Strategy:
    1. SSH + Python to discover the actual log file path from supervisor config
    2. Then tail that file directly
    3. Falls back to common log paths if config parsing fails
    """
    # Step 1: discover log file path
    discover_py = (
        "import glob, re\n"
        f"proc = '{process}'\n"
        f"log_type = '{log_type}'\n"
        "for f in sorted(glob.glob('/etc/supervisor/conf.d/*.conf')):\n"
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
    r = ssh_exec(host, port, user, f"python3 -c '{discover_py}'", timeout=timeout)
    log_file = r["stdout"].strip()

    # Step 2: tail the discovered file, or try fallbacks
    fallbacks = (
        [f"/var/log/supervisor/{process}.stderr.log", f"/var/log/supervisor/{process}.log"]
        if log_type == "stderr"
        else [f"/var/log/supervisor/{process}.stdout.log", f"/var/log/supervisor/{process}.log"]
    )
    not_found_msg = "(stderr log not found)" if log_type == "stderr" else "(no log available)"

    if log_file:
        tail_cmd = f"tail -n {lines} '{log_file}' 2>/dev/null"
    else:
        # Chain fallbacks with ||
        tail_cmd = " || ".join(f"tail -n {lines} '{fb}' 2>/dev/null" for fb in fallbacks)

    r = ssh_exec(host, port, user, tail_cmd, timeout=timeout)
    output = r["stdout"]

    if not output.strip() and r["exit_code"] != 0:
        output = not_found_msg

    truncated = "..." in output and "tail" in output.lower()

    return SupervisorLogLines(
        process=process,
        lines=output.strip().splitlines() if output.strip() else [],
        truncated=truncated,
    )


def supervisor_reread(
    config: str = "",
    host: str = "",
    port: int = 0,
    user: str = "",
    timeout: int = 30,
) -> SupervisorActionResult:
    """Reload supervisor configuration (reread + update)."""
    r = ssh_exec(host, port, user, "supervisorctl reread && supervisorctl update", timeout=timeout)
    success = r["exit_code"] == 0
    return SupervisorActionResult(
        success=success,
        process="config",
        message=r["stderr"].strip() if not success else "Configuration reloaded",
        stdout=r["stdout"],
        stderr=r["stderr"],
    )
