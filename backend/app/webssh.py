"""WebSocket SSH terminal — bidirectional PTY forwarding.

Browser <-> WebSocket <-> asyncssh PTY <-> remote host

For local_machine assets, uses subprocess + pty directly (no SSH).
For remote assets, uses asyncssh for SSH PTY sessions.

Protocol (JSON over WebSocket text frames):
  Client -> Server:
    {"type": "data", "data": "..."}          — keystrokes / terminal input
    {"type": "resize", "rows": 24, "cols": 80} — terminal resize
  Server -> Client:
    {"type": "data", "data": "..."}          — terminal output (base64)
    {"type": "exit", "code": 0}              — session ended
    {"type": "error", "message": "..."}      — connection error
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import pty
import select
import signal
import subprocess
import termios
import tty

logger = logging.getLogger(__name__)


async def handle_webssh(
    ws,
    host: str,
    port: int,
    user: str,
    cols: int = 80,
    rows: int = 24,
    local_machine: bool = False,
    timeout: int = 120,
):
    """Handle a WebSocket SSH session."""
    if local_machine:
        await _handle_local(ws, user, cols, rows)
    else:
        await _handle_remote(ws, host, port, user, cols, rows, timeout)


async def _handle_local(ws, user: str, cols: int, rows: int):
    """Local PTY session — no SSH, direct subprocess."""
    master_fd = None
    proc = None
    try:
        # Open a PTY pair
        master_fd, slave_fd = pty.openpty()
        
        # Set PTY size
        import fcntl
        import struct
        # TIOCSWINSZ ioctl
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
        
        # Get user's default shell
        shell = os.environ.get("SHELL", "/bin/bash")
        
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["LANG"] = "zh_TW.UTF-8"
        env["LC_ALL"] = "zh_TW.UTF-8"
        
        # Start shell process with PTY
        proc = subprocess.Popen(
            [shell],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            preexec_fn=os.setsid,
        )
        os.close(slave_fd)  # Close slave in parent
        
        logger.info("Local PTY created: pid=%d, shell=%s", proc.pid, shell)
        
        await ws.send_text(json.dumps({"type": "ready", "pid": str(proc.pid)}))
        
        # Bidirectional forwarding
        ws_to_pty_task = asyncio.create_task(_ws_to_pty(ws, master_fd))
        pty_to_ws_task = asyncio.create_task(_pty_to_ws(ws, master_fd))
        
        done, pending = await asyncio.wait(
            {ws_to_pty_task, pty_to_ws_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        
        # Wait for process
        exit_code = proc.wait()
        logger.info("Local session ended: exit_code=%d", exit_code)
        await ws.send_text(json.dumps({"type": "exit", "code": exit_code}))
        
    except Exception as e:
        logger.exception("Local WebSSH error")
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        if master_fd is not None:
            os.close(master_fd)
        if proc and proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except Exception:
                pass


async def _handle_remote(ws, host: str, port: int, user: str, cols: int, rows: int, timeout: int):
    """Remote SSH PTY session via asyncssh."""
    import asyncssh
    
    ssh_conn = None
    try:
        ssh_conn = await asyncio.wait_for(
            asyncssh.connect(
                host,
                port=port,
                username=user,
                known_hosts=None,
            ),
            timeout=15,
        )
        logger.info("SSH connected: %s@%s:%d", user, host, port)

        process = await ssh_conn.create_process(
            "",
            request_pty=True,
            term_type="xterm-256color",
            term_size=(rows, cols),
            env={
                "LANG": "zh_TW.UTF-8",
                "LC_ALL": "zh_TW.UTF-8",
            },
        )

        logger.info("Remote PTY created")
        await ws.send_text(json.dumps({"type": "ready"}))

        ws_to_ssh_task = asyncio.create_task(_ws_to_ssh(ws, process))
        ssh_to_ws_task = asyncio.create_task(_ssh_to_ws(ws, process))

        done, pending = await asyncio.wait(
            {ws_to_ssh_task, ssh_to_ws_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        exit_code = getattr(process, "exit_status", 0) or 0
        logger.info("SSH session ended: exit_code=%s", exit_code)
        await ws.send_text(json.dumps({"type": "exit", "code": exit_code}))

    except asyncio.TimeoutError:
        logger.error("SSH connection timeout: %s@%s:%d", user, host, port)
        try:
            await ws.send_text(json.dumps({"type": "error", "message": "SSH connection timeout"}))
        except Exception:
            pass
    except Exception as e:
        logger.exception("Remote WebSSH error")
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        if ssh_conn:
            try:
                ssh_conn.close()
                await ssh_conn.wait_closed()
            except Exception:
                pass


# ── Local PTY helpers ───────────────────────────────────────────────────────

async def _ws_to_pty(ws, master_fd):
    """Forward WebSocket messages -> local PTY master."""
    try:
        while True:
            raw = await ws.receive_text()
            if raw is None:
                break
            
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type == "data":
                input_data = data.get("data", "")
                try:
                    os.write(master_fd, input_data.encode("utf-8", errors="replace"))
                except OSError as e:
                    logger.warning("PTY write error: %s", e)
                    break

            elif msg_type == "resize":
                rows = data.get("rows", 24)
                cols = data.get("cols", 80)
                try:
                    import fcntl
                    import struct
                    winsize = struct.pack("HHHH", rows, cols, 0, 0)
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                except Exception as e:
                    logger.warning("PTY resize error: %s", e)

            elif msg_type == "close":
                break

    except Exception as e:
        logger.warning("ws_to_pty error: %s", e)


async def _pty_to_ws(ws, master_fd):
    """Forward local PTY master -> WebSocket."""
    loop = asyncio.get_event_loop()
    try:
        while True:
            # Use select to wait for data
            r, _, _ = await loop.run_in_executor(
                None, select.select, [master_fd], [], [], 1.0
            )
            if not r:
                continue
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            encoded = base64.b64encode(data).decode("ascii")
            await ws.send_text(json.dumps({"type": "data", "data": encoded}))
    except Exception as e:
        logger.warning("pty_to_ws error: %s", e)


# ── Remote SSH helpers ──────────────────────────────────────────────────────

async def _ws_to_ssh(ws, process):
    """Forward WebSocket messages -> SSH stdin."""
    try:
        while True:
            raw = await ws.receive_text()
            if raw is None:
                break
            
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type == "data":
                input_data = data.get("data", "")
                try:
                    process.stdin.write(input_data)
                except Exception as e:
                    logger.warning("SSH stdin write error: %s", e)
                    break

            elif msg_type == "resize":
                new_rows = data.get("rows", 24)
                new_cols = data.get("cols", 80)
                try:
                    process.change_terminal_size(new_rows, new_cols)
                except Exception as e:
                    logger.warning("SSH resize error: %s", e)

            elif msg_type == "close":
                break

    except Exception as e:
        logger.warning("ws_to_ssh error: %s", e)
    finally:
        try:
            process.stdin.close()
        except Exception:
            pass


async def _ssh_to_ws(ws, process):
    """Forward SSH stdout -> WebSocket."""
    try:
        while True:
            data = await process.stdout.read(4096)
            if not data:
                break
            encoded = base64.b64encode(data).decode("ascii")
            await ws.send_text(json.dumps({"type": "data", "data": encoded}))
    except Exception as e:
        logger.warning("ssh_to_ws error: %s", e)
