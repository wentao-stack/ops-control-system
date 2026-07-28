from __future__ import annotations

import os
import signal
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
        proc = subprocess.Popen(
            ssh_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            return {
                "stdout": stdout.decode("utf-8", errors="replace"),
                "stderr": stderr.decode("utf-8", errors="replace"),
                "exit_code": proc.returncode,
                "duration": round(time.monotonic() - start, 2),
            }
        except subprocess.TimeoutExpired:
            # Kill the entire process group to clean up orphaned SSH processes
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                proc.kill()
            stdout, stderr = proc.communicate()
            return {
                "stdout": (stdout or b"").decode("utf-8", errors="replace"),
                "stderr": f"Command timed out after {timeout}s",
                "exit_code": -1,
                "duration": timeout,
            }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": str(e),
            "exit_code": -1,
            "duration": round(time.monotonic() - start, 2),
        }


def ssh_ping(host: str, port: int, user: str) -> bool:
    """Quick SSH connectivity check."""
    try:
        proc = subprocess.Popen(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
             "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
             "-p", str(port), f"{user}@{host}", "echo ok"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            proc.communicate(timeout=10)
            return proc.returncode == 0
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                proc.kill()
            proc.communicate()
            return False
    except Exception:
        return False
