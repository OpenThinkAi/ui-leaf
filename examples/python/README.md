# examples/python — ui-leaf counter (Python)

A working Python example that drives a ui-leaf counter view using only the
standard library — no pip installs required.

## How to run

```sh
# From the repo root (development build):
python3 examples/python/counter.py

# With an installed binary on PATH:
python3 examples/python/counter.py
```

A browser tab opens automatically. Click **+1** or **−1**; each click sends a
`mutate` event that the Python script handles, increments its in-memory
counter, and writes the result back to the binary. Close the tab to exit.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `UI_LEAF_BIN` | `ui-leaf` | Override the binary path (e.g. point at a local build). |
| `UI_LEAF_VIEWS_ROOT` | `examples/views/` relative to the script | Override the views directory. |
| `UI_LEAF_SMOKE` | `0` | Set to `1` for headless smoke-test mode: no browser, sends an update, closes cleanly, exits 0. |

## Dependencies

Standard library only: `asyncio`, `json`, `os`, `signal`, `sys`.

Python 3.10+ is required (`asyncio.TaskGroup` and `match` are not used;
`asyncio.create_subprocess_exec` is available since Python 3.5).
