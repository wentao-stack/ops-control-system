"""WebSocket SSH terminal — bidirectional PTY forwarding.

Browser <-> WebSocket <-> asyncssh PTY <-> remote host

For local_machine assets, uses asyncio subprocess + PTY directly (no SSH).
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
import fcntl
import json
import logging
import os
import pty
import signal
import struct
import subprocess
import termios

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


# ── Local PTY session ────────────────────────────────────────────────────────

async def _handle_local(ws, user: str, cols: int, rows: int):
    """Local PTY session — no SSH, direct asyncio subprocess."""
    master_fd: int | None = None
    proc: asyncio.subprocess.Process | None = None
    try:
        master_fd, slave_fd = pty.openpty()

        # Set PTY size
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)

        shell = os.environ.get("SHELL", "/bin/bash")

        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["LANG"] = "zh_TW.UTF-8"
        env["LC_ALL"] = "zh_TW.UTF-8"

        # Use asyncio subprocess — non-blocking by design
        proc = await asyncio.create_subprocess_exec(
            shell,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            start_new_session=True,
        )
        os.close(slave_fd)

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

        # Non-blocking wait for process
        exit_code = await proc.wait()
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
            try:
                os.close(master_fd)
            except OSError:
                pass
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass


# ── Remote SSH session ───────────────────────────────────────────────────────

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
            encoding=None,  # Force binary mode so stdout.read() returns bytes
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

        exit_code = getattr(process, "exit_status", None) or 0
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
        if ssh_conn is not None:
            try:
                ssh_conn.close()
                await ssh_conn.wait_closed()
            except Exception:
                pass


# ── Local PTY helpers ────────────────────────────────────────────────────────

async def _ws_to_pty(ws, master_fd: int):
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
                # Encode string input to bytes before writing to PTY
                input_bytes = data.get("data", "").encode("utf-8", errors="replace")
                try:
                    os.write(master_fd, input_bytes)
                except OSError as e:
                    logger.warning("PTY write error: %s", e)
                    break

            elif msg_type == "resize":
                rows = data.get("rows", 24)
                cols = data.get("cols", 80)
                try:
                    winsize = struct.pack("HHHH", rows, cols, 0, 0)
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                except Exception as e:
                    logger.warning("PTY resize error: %s", e)

            elif msg_type == "close":
                break

    except Exception as e:
        logger.warning("ws_to_pty error: %s", e)


async def _pty_to_ws(ws, master_fd: int):
    """Forward local PTY master -> WebSocket using loop.add_reader (zero-copy async)."""
    loop = asyncio.get_event_loop()
    read_event = asyncio.Event()
    has_data = False

    def _on_readable():
        nonlocal has_data
        has_data = True
        # Schedule the event on the event loop thread
        try:
            loop.call_soon_threadsafe(read_event.set)
        except Exception:
            pass

    try:
        loop.add_reader(master_fd, _on_readable)

        while True:
            await read_event.wait()
            has_data = False
            read_event.clear()

            # Read all available data (non-blocking since select already told us data is ready)
            chunk_size = 8192
            while True:
                try:
                    data = os.read(master_fd, chunk_size)
                except BlockingIOError:
                    break
                except OSError:
                    return

                if not data:
                    return  # PTY closed

                encoded = base64.b64encode(data).decode("ascii")
                await ws.send_text(json.dumps({"type": "data", "data": encoded}))
    except Exception as e:
        logger.warning("pty_to_ws error: %s", e)
    finally:
        try:
            loop.remove_reader(master_fd)
        except Exception:
            pass


# ── Remote SSH helpers ───────────────────────────────────────────────────────

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
                # encoding=None makes stdin expect bytes
                input_bytes = data.get("data", "").encode("utf-8", errors="replace")
                try:
                    process.stdin.write(input_bytes)
                    await process.stdin.drain()
                except Exception as e:
                    logger.warning("SSH stdin write error: %s", e)
                    break

            elif msg_type == "resize":
                # Handle both {cols: N, rows: M} and nested {cols: {cols: N, rows: M}}
                cols_data = data.get("cols", 80)
                rows_data = data.get("rows", 24)
                # If cols_data is a dict (xterm 5.x resize event object), extract values
                if isinstance(cols_data, dict):
                    new_cols = int(cols_data.get("cols", 80))
                    new_rows = int(cols_data.get("rows", 24))
                else:
                    new_cols = int(cols_data)
                    new_rows = int(rows_data)
                try:
                    process.change_terminal_size(new_cols, new_rows)
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
    """Forward SSH stdout -> WebSocket using read() with chunk size."""
    try:
        while True:
            # read(n) on asyncssh reader reads up to n bytes and returns
            data = await process.stdout.read(8192)
            if not data:
                break
            # Handle both bytes and str (asyncssh may return either depending on mode)
            if isinstance(data, str):
                data = data.encode("utf-8", errors="replace")
            encoded = base64.b64encode(data).decode("ascii")
            await ws.send_text(json.dumps({"type": "data", "data": encoded}))
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.warning("ssh_to_ws error: %s (type=%s)", e, type(e).__name__)
