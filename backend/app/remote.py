from __future__ import annotations

import subprocess
import time

# ── SSH remote command execution ─────────────────────────────────────────────
# Uses local `ssh` command with key-based auth. No passwords in code.
# Timeout enforced at subprocess level.

SSH_TIMEOUT = 30  # seconds


def ssh_exec(host: str, port: int, user: str, command: str, timeout: int = SSH_TIMEOUT) -> dict:
    """Execute a command on a remote host via SSH.

    Returns dict with stdout, stderr, exit_code, duration.
    """
    ssh_cmd = [
        "ssh",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-o", "PasswordAuthentication=no",
        "-p", str(port),
        f"{user}@{host}",
        command,
    ]
    start = time.monotonic()
    try:
        result = subprocess.run(
            ssh_cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.returncode,
            "duration": round(time.monotonic() - start, 2),
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"Command timed out after {timeout}s",
            "exit_code": -1,
            "duration": timeout,
        }


def ssh_ping(host: str, port: int, user: str) -> bool:
    """Quick SSH connectivity check."""
    try:
        result = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
             "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
             "-p", str(port), f"{user}@{host}", "echo ok"],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False
