#!/usr/bin/env python3
"""kobe-kernel-bridge: one thread's IPython kernel for kobe-sandbox-agent (KOBE-464).

docs/specs/notebooks.md NB10. The agent starts this program (root-owned, read-only, in the image)
under the kernel's own uid and talks to it over stdio only, one JSON object per line:

  agent -> bridge   {"op": "execute", "id": "<id>", "code": "<source>"}
                    {"op": "interrupt"}
                    {"op": "shutdown"}          (also: stdin closed)
  bridge -> agent   {"ev": "ready"}
                    {"ev": "output", "id": "<id>", "output": {<nbformat 4 output>}}
                    {"ev": "done", "id": "<id>", "status": "ok"|"error"|"interrupted",
                     "execution_count": <int|null>}
                    {"ev": "died"}               (the kernel process is gone)
                    {"ev": "fatal", "message": "<text>"}

The kernel is ipykernel, started by jupyter_client with the ZeroMQ "ipc" transport: unix sockets
in a fresh 0700 directory, signed with a random key. No TCP port is opened: ipykernel's IOPub
"pipe" (a 127.0.0.1 listener that forwards the output of forked child processes) is switched off by
the launcher below, so a forked child's Python-level prints are not shown. The kernel's own
stdin/stdout/stderr are /dev/null, so nothing it writes can reach this protocol. IPython and Jupyter
read their configuration and startup files from that directory only (never the shared $HOME).
Outputs are passed on as the kernel sends them; the agent applies Kobe's caps and MIME allow-list.

Internet (NB17): like the shell tool, through egress-proxy. The agent passes the token *file*
(KOBE_EGRESS_TOKEN_FILE), the proxy URL and the thread id, never the token; before each cell the
bridge runs a silent snippet in the kernel that reads the current token and sets HTTPS_PROXY and
friends (as the shell tool's BASH_ENV script does per command), so a rotated token is picked up.
One execution runs at a time; `interrupt` sends SIGINT to the kernel.
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading

READY_TIMEOUT_S = 60
# A line the agent would refuse anyway: replaced by a note before it is written.
MAX_LINE_BYTES = 1024 * 1024
OUTPUT_TYPES = ("stream", "display_data", "execute_result", "error")
KERNEL_NAME = "kobe-python"
# Run silently before each cell when egress is wired: the same rules as egress-env.sh (only
# [A-Za-z0-9._:-] in the parts; anything else exports nothing).
EGRESS_REFRESH = """
def __kobe_egress():
    import os, re
    f, p = os.environ.get("KOBE_EGRESS_TOKEN_FILE"), os.environ.get("KOBE_EGRESS_PROXY")
    if not f or not p:
        return
    try:
        with open(f, encoding="ascii") as fh:
            token = fh.readline().strip()
    except (OSError, ValueError):
        return
    user = os.environ.get("KOBE_THREAD_ID", "kobe")
    host = (p[len("http://"):] if p.startswith("http://") else p).rstrip("/")
    if not token or not re.fullmatch(r"[A-Za-z0-9._:-]+", token + user + host):
        return
    url = "http://%s:%s@%s" % (user, token, host)
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        os.environ[name] = url
__kobe_egress()
del __kobe_egress
"""
# ipykernel_launcher, with the IOPub pipe off (no loopback TCP listener in the kernel).
LAUNCHER = """import sys
del sys.path[0]
import ipykernel.iostream as _io
_init = _io.IOPubThread.__init__
def _no_pipe(self, socket, pipe=False, session=False):
    _init(self, socket, pipe=False, session=session)
_io.IOPubThread.__init__ = _no_pipe
from ipykernel import kernelapp
kernelapp.launch_new_instance()
"""

_write_lock = threading.Lock()


def emit(message):
    line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def note(text):
    return {"output_type": "stream", "name": "stderr", "text": text}


def output_of(msg_type, content):
    if msg_type == "stream":
        return {"output_type": "stream", "name": content.get("name", "stdout"), "text": content.get("text", "")}
    if msg_type == "error":
        return {
            "output_type": "error",
            "ename": content.get("ename", ""),
            "evalue": content.get("evalue", ""),
            "traceback": list(content.get("traceback", [])),
        }
    out = {"output_type": msg_type, "data": content.get("data", {}), "metadata": content.get("metadata", {})}
    if msg_type == "execute_result":
        out["execution_count"] = content.get("execution_count")
    return out


def emit_output(exec_id, output):
    message = {"ev": "output", "id": exec_id, "output": output}
    size = len(json.dumps(message, ensure_ascii=False).encode("utf-8"))
    if size > MAX_LINE_BYTES:
        message["output"] = note(f"[Kobe: output truncated: one output of {size} bytes was too large]\n")
    emit(message)


def write_kernel_spec(private, data_dir):
    launcher = os.path.join(private, "kobe_kernel_launcher.py")
    with open(launcher, "w", encoding="utf-8") as f:
        f.write(LAUNCHER)
    spec_dir = os.path.join(data_dir, "kernels", KERNEL_NAME)
    os.makedirs(spec_dir, mode=0o700, exist_ok=True)
    spec = {
        "argv": [sys.executable, launcher, "-f", "{connection_file}"],
        "display_name": "Python 3 (Kobe)",
        "language": "python",
    }
    with open(os.path.join(spec_dir, "kernel.json"), "w", encoding="utf-8") as f:
        json.dump(spec, f)


def private_environment(private):
    """The kernel's environment: the agent's (already an allow-list) with private config dirs."""
    env = dict(os.environ)
    for name in ("PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"):
        env.pop(name, None)
    for name, sub in (
        ("IPYTHONDIR", "ipython"),
        ("JUPYTER_CONFIG_DIR", "config"),
        ("JUPYTER_DATA_DIR", "data"),
        ("JUPYTER_RUNTIME_DIR", "runtime"),
        ("MPLCONFIGDIR", "matplotlib"),
    ):
        path = os.path.join(private, sub)
        os.makedirs(path, mode=0o700, exist_ok=True)
        env[name] = path
    env["JUPYTER_CONFIG_PATH"] = env["JUPYTER_CONFIG_DIR"]
    env["JUPYTER_PATH"] = env["JUPYTER_DATA_DIR"]
    env["JUPYTER_PLATFORM_DIRS"] = "1"
    env["MPLBACKEND"] = "module://matplotlib_inline.backend_inline"
    env["PYDEVD_DISABLE_FILE_VALIDATION"] = "1"
    return env


class Bridge:
    def __init__(self, private):
        self.private = private
        self.commands = queue.Queue()
        self.km = None
        self.kc = None

    def start(self):
        env = private_environment(self.private)
        # The bridge reads the same variables (jupyter_client resolves its dirs from them).
        os.environ.update({k: v for k, v in env.items() if k.startswith(("JUPYTER", "IPYTHON"))})
        write_kernel_spec(self.private, env["JUPYTER_DATA_DIR"])
        from jupyter_client import KernelManager

        self.km = KernelManager(
            kernel_name=KERNEL_NAME,
            transport="ipc",
            ip=os.path.join(self.private, "kernel"),
            connection_file=os.path.join(self.private, "runtime", "kernel.json"),
        )
        devnull = subprocess.DEVNULL
        self.km.start_kernel(env=env, cwd=os.getcwd(), stdin=devnull, stdout=devnull, stderr=devnull)
        self.kc = self.km.client()
        self.kc.allow_stdin = False
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=READY_TIMEOUT_S)

    def read_commands(self):
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except ValueError:
                continue
            if not isinstance(command, dict):
                continue
            if command.get("op") == "interrupt":
                try:
                    self.km.interrupt_kernel()
                except Exception as error:  # noqa: BLE001 - reported, never fatal
                    emit({"ev": "fatal", "message": f"interrupt failed: {error}"[:500]})
                continue
            self.commands.put(command)
            if command.get("op") == "shutdown":
                return
        self.commands.put({"op": "shutdown"})

    def execute(self, exec_id, code):
        if os.environ.get("KOBE_EGRESS_TOKEN_FILE") and os.environ.get("KOBE_EGRESS_PROXY"):
            # Silent and before the cell on the same shell channel, so it runs first; its own
            # messages carry another parent id and are not forwarded.
            self.kc.execute(
                EGRESS_REFRESH, silent=True, store_history=False, allow_stdin=False, stop_on_error=False
            )
        msg_id = self.kc.execute(code, store_history=True, allow_stdin=False, stop_on_error=True)
        interrupted = False
        while True:
            try:
                msg = self.kc.get_iopub_msg(timeout=0.5)
            except queue.Empty:
                if not self.km.is_alive():
                    emit({"ev": "died"})
                    return False
                continue
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            msg_type = msg.get("msg_type")
            content = msg.get("content", {})
            if msg_type in OUTPUT_TYPES:
                if msg_type == "error" and content.get("ename") == "KeyboardInterrupt":
                    interrupted = True
                emit_output(exec_id, output_of(msg_type, content))
            elif msg_type == "status" and content.get("execution_state") == "idle":
                break
        status, count = "error", None
        while True:
            try:
                reply = self.kc.get_shell_msg(timeout=5)
            except queue.Empty:
                break
            if reply.get("parent_header", {}).get("msg_id") == msg_id:
                content = reply.get("content", {})
                status = "ok" if content.get("status") == "ok" else "error"
                count = content.get("execution_count")
                break
        if interrupted:
            status = "interrupted"
        emit({"ev": "done", "id": exec_id, "status": status, "execution_count": count})
        return True

    def serve(self):
        threading.Thread(target=self.read_commands, daemon=True).start()
        emit({"ev": "ready"})
        while True:
            command = self.commands.get()
            if command.get("op") == "shutdown":
                return
            if command.get("op") != "execute":
                continue
            exec_id = str(command.get("id", ""))
            code = command.get("code")
            if not isinstance(code, str):
                emit({"ev": "done", "id": exec_id, "status": "error", "execution_count": None})
                continue
            if not self.execute(exec_id, code):
                return

    def stop(self):
        try:
            if self.kc is not None:
                self.kc.stop_channels()
            if self.km is not None and self.km.has_kernel:
                self.km.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001 - best effort on the way out
            pass


def main():
    private = tempfile.mkdtemp(prefix="kobe-kernel-")
    bridge = Bridge(private)
    try:
        try:
            bridge.start()
        except Exception as error:  # noqa: BLE001 - the agent shows a fixed message
            emit({"ev": "fatal", "message": f"the kernel did not start: {type(error).__name__}: {error}"[:500]})
            return 1
        bridge.serve()
        return 0
    finally:
        bridge.stop()
        shutil.rmtree(private, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
