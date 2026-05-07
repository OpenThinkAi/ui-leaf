#!/usr/bin/env python3
"""
Counter example — ui-leaf via asyncio subprocess (stdlib only).

Run:
    python3 examples/python/counter.py

Smoke mode (no browser, exits automatically after one round-trip):
    UI_LEAF_SMOKE=1 python3 examples/python/counter.py

See examples/python/README.md for full usage and env-var docs.
"""

import asyncio
import json
import os
import signal
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VIEWS_ROOT = os.environ.get(
    "UI_LEAF_VIEWS_ROOT",
    os.path.normpath(os.path.join(SCRIPT_DIR, "..", "views")),
)
UI_LEAF_BIN = os.environ.get("UI_LEAF_BIN", "ui-leaf")
SMOKE = os.environ.get("UI_LEAF_SMOKE") == "1"


async def main() -> None:
    count = 0

    config = {
        "version": "1",
        "view": "counter",
        "viewsRoot": VIEWS_ROOT,
        "data": {"initialCount": count},
        "mutations": ["increment"],
        "port": 0,
        # Smoke mode suppresses browser open so CI can run headless.
        "openBrowser": not SMOKE,
    }

    # Spawn ui-leaf mount. Binary stderr inherits the parent process's stderr
    # so build errors and diagnostics remain visible to the operator.
    proc = await asyncio.create_subprocess_exec(
        UI_LEAF_BIN,
        "mount",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=None,  # inherit
    )

    assert proc.stdin is not None
    assert proc.stdout is not None

    # Send the config as the first (and only config) line on stdin.
    proc.stdin.write(json.dumps(config).encode() + b"\n")
    await proc.stdin.drain()
    print("[python] sent config; waiting for events…", file=sys.stderr)

    ready_future = asyncio.get_running_loop().create_future()  # Future[str]
    closed_event = asyncio.Event()

    async def send(msg: dict) -> None:
        """Write one JSON line to the binary's stdin."""
        proc.stdin.write(json.dumps(msg).encode() + b"\n")  # type: ignore[union-attr]
        await proc.stdin.drain()  # type: ignore[union-attr]

    async def read_events() -> None:
        nonlocal count
        async for raw in proc.stdout:
            line = raw.decode().strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                print(f"[python] bad JSON: {line!r}", file=sys.stderr)
                continue

            typ = event.get("type")

            if typ == "ready":
                url = event.get("url", "")
                print(f"[python] view ready at {url}", file=sys.stderr)
                if not ready_future.done():
                    ready_future.set_result(url)

            elif typ == "mutate":
                mid = event.get("id")
                name = event.get("name")
                args = event.get("args") or {}
                by = args.get("by", 1) if isinstance(args, dict) else 1
                if name == "increment":
                    count += by
                    print(
                        f"[python] mutation '{name}' by={by} → count={count}",
                        file=sys.stderr,
                    )
                    await send(
                        {"version": "1", "type": "result", "id": mid, "value": {"count": count}}
                    )
                else:
                    await send(
                        {"version": "1", "type": "error", "id": mid, "message": f"unknown mutation: {name}"}
                    )

            elif typ == "closed":
                print("[python] view closed", file=sys.stderr)
                closed_event.set()
                break

            elif typ == "error":
                msg = event.get("message", "")
                print(f"[python] error: {msg}", file=sys.stderr)
                closed_event.set()
                break

    reader_task = asyncio.create_task(read_events())

    # Wait for the binary to signal it is ready before proceeding.
    await ready_future

    if SMOKE:
        # Headless round-trip: push a data update then request a clean close.
        await send({"version": "1", "type": "update", "data": {"initialCount": 42}})
        await send({"version": "1", "type": "close"})
        await asyncio.wait_for(closed_event.wait(), timeout=10.0)
    else:
        # Normal interactive mode: wire SIGTERM/SIGINT so Ctrl-C or a process
        # manager can close the view cleanly (not available on Windows).
        loop = asyncio.get_running_loop()

        async def graceful_close() -> None:
            if proc.stdin and not proc.stdin.is_closing():
                await send({"version": "1", "type": "close"})

        if sys.platform != "win32":
            loop.add_signal_handler(
                signal.SIGTERM,
                lambda: loop.create_task(graceful_close()),
            )
            loop.add_signal_handler(
                signal.SIGINT,
                lambda: loop.create_task(graceful_close()),
            )

        await closed_event.wait()

    await reader_task
    await proc.wait()
    print("[python] done.", file=sys.stderr)


asyncio.run(main())
