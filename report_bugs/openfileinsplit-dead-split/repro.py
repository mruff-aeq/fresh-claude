#!/usr/bin/env python3
"""Repro: openFileInSplit() against a dead splitId returns true, shows nothing.

A split id can die at any time (the user closes the split, or closes the
split's last tab, which collapses it). openFileInSplit() with such an id
reports success but no split ever displays the file, so plugins holding a
split id have no way to detect the failure.

Launches a real `fresh` in a pseudo-terminal (pty) with an isolated HOME
containing only the minimal init.ts next to this script; the init.ts
writes a JSON verdict to a temp file this script reads. No external
dependencies.

Exit codes: 0 = bug reproduced, 1 = not reproduced, 2 = setup problem.
"""

import fcntl
import json
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
        result_path = os.path.join(tmp, "result.json")
        ws = os.path.join(tmp, "ws")
        os.makedirs(ws)
        test_file = os.path.join(ws, "hello.txt")
        with open(test_file, "w") as f:
            f.write("hello from the repro\n")

        home = os.path.join(tmp, "home")
        cfg = os.path.join(home, ".config", "fresh")
        os.makedirs(cfg)
        with open(os.path.join(HERE, "init.ts")) as f:
            init = f.read().replace("__RESULT__", result_path).replace("__TESTFILE__", test_file)
        with open(os.path.join(cfg, "init.ts"), "w") as f:
            f.write(init)

        proc, master = launch_fresh(home, ws, os.path.join(tmp, "stderr.log"))

        deadline = time.time() + 15
        while time.time() < deadline and not os.path.exists(result_path):
            time.sleep(0.5)
        if not os.path.exists(result_path):
            print("error: init.ts never wrote a result (fresh failed to start?)", file=sys.stderr)
            return 2

        with open(result_path) as f:
            res = json.load(f)
        print(f"split was closed first:      {res['splitGone']}")
        print(f"openFileInSplit returned:    {res['openRet']}")
        print(f"file visible in any split:   {res['fileVisible']}")

        if res["splitGone"] and res["openRet"] and not res["fileVisible"]:
            print("\nBUG REPRODUCED — success reported for a dead split, file shown nowhere")
            return 0
        print("\nnot reproduced")
        return 1
    finally:
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
        if master is not None:
            os.close(master)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
