#!/usr/bin/env python3
"""Repro: editor.setSplitRatio(splitId, ...) on a leaf split panics fresh.

Launches a real `fresh` in a pseudo-terminal (pty) with an isolated HOME
containing only the minimal init.ts next to this script, then watches
stderr for the panic. No external dependencies.

Exit codes: 0 = bug reproduced, 1 = not reproduced, 2 = setup problem.
"""

import fcntl
import os
import pty
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

PANIC_NEEDLE = "points to a leaf"
HERE = os.path.dirname(os.path.abspath(__file__))


def drain(fd):
    """Keep reading the pty master so fresh never blocks on a full buffer."""
    try:
        while os.read(fd, 65536):
            pass
    except OSError:
        pass


def launch_fresh(home, ws, stderr_path):
    env = dict(os.environ)
    # fresh reads ~/.config/fresh regardless of XDG_CONFIG_HOME, so isolate
    # via HOME; drop FRESH_PROFILE in case we run inside fresh-claude.
    env["HOME"] = home
    env.pop("FRESH_PROFILE", None)
    env.setdefault("TERM", "xterm-256color")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 180, 0, 0))
    proc = subprocess.Popen(
        ["fresh", "--no-restore"],
        stdin=slave, stdout=slave, stderr=open(stderr_path, "w"),
        cwd=ws, env=env, start_new_session=True,
    )
    os.close(slave)
    threading.Thread(target=drain, args=(master,), daemon=True).start()
    return proc, master


def main():
    if shutil.which("fresh") is None:
        print("error: `fresh` not found on PATH", file=sys.stderr)
        return 2

    tmp = tempfile.mkdtemp(prefix="fresh-bug-")
    proc = master = None
    try:
        home = os.path.join(tmp, "home")
        cfg = os.path.join(home, ".config", "fresh")
        os.makedirs(cfg)
        shutil.copy(os.path.join(HERE, "init.ts"), os.path.join(cfg, "init.ts"))
        ws = os.path.join(tmp, "ws")
        os.makedirs(ws)
        stderr_log = os.path.join(tmp, "stderr.log")

        proc, master = launch_fresh(home, ws, stderr_log)

        # init.ts fires the panic ~1s after startup; give it up to 15s.
        deadline = time.time() + 15
        while time.time() < deadline:
            with open(stderr_log, errors="replace") as f:
                log = f.read()
            if PANIC_NEEDLE in log:
                print("BUG REPRODUCED — fresh panicked:\n")
                for line in log.splitlines():
                    if "panic" in line.lower() or PANIC_NEEDLE in line:
                        print(f"  {line}")
                return 0
            if proc.poll() is not None and not log:
                break
            time.sleep(0.5)

        print("not reproduced (no panic within 15s)")
        tail = log[-500:]
        if tail:
            print(f"stderr tail:\n{tail}")
        return 1
    finally:
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
        if master is not None:
            os.close(master)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
