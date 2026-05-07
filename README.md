# ui-leaf

Customizable browser views, on demand, for any CLI.

`ui-leaf` is a self-contained binary. Any program that can spawn a subprocess and
read/write line-delimited JSON on stdio can drive a browser view — Bash scripts,
Python CLIs, Rust tools, Node programs, AI agents. No Node.js, no Bun, no runtime
required on the end user's machine. A thin JS wrapper for ergonomic Node use ships
with v1.0.0.

The view is your code — a `.tsx` file in your project's `views/` directory. That's
the **bring-your-own-view** part.

## Status

`v1.0.0 — release in progress`. Binary architecture and stdio protocol are stable.
JS wrapper API documentation lands with the publish-target swap (v1.0.0 final). The
full design doc (`docs/design.md`) ships alongside the binary release.

## Install

### Binary on `$PATH` (any language)

```bash
npm install -g @openthink/ui-leaf
# or: bun add -g @openthink/ui-leaf  /  pnpm add -g @openthink/ui-leaf
```

Puts `ui-leaf` on your `$PATH`. Use for Bash, Python, Rust, Go, or any other
language — there is no Node dependency at runtime.

### Direct download (no Node required)

Grab the right binary from
[GitHub Releases](https://github.com/OpenThinkAi/ui-leaf/releases/latest):

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | `ui-leaf-darwin-arm64` |
| macOS (Intel) | `ui-leaf-darwin-x64` |
| Linux x64 | `ui-leaf-linux-x64` |
| Linux arm64 | `ui-leaf-linux-arm64` |
| Windows x64 | `ui-leaf-windows-x64.exe` |

Verify the SHA256 against `checksums.txt` from the same release, then make the
binary executable:

```bash
# macOS Apple Silicon example:
curl -L -o ui-leaf \
  https://github.com/OpenThinkAi/ui-leaf/releases/latest/download/ui-leaf-darwin-arm64
grep ui-leaf-darwin-arm64 checksums.txt | sha256sum -c
chmod +x ui-leaf && sudo mv ui-leaf /usr/local/bin/
```

### JS wrapper (`npm install @openthink/ui-leaf`, v1.0.0)

With v1.0.0, `npm install @openthink/ui-leaf` will install the thin JS wrapper;
`postinstall` downloads and verifies the right binary for your platform automatically.
Full JS wrapper API documentation lands with the publish-target swap. See
the `docs/design.md §6` section (ships with v1.0.0) for the planned API surface.

```bash
npm install @openthink/ui-leaf
# or: bun add @openthink/ui-leaf  /  pnpm add @openthink/ui-leaf
```

## Quickstart: non-JS callers

The binary speaks line-delimited JSON on stdin/stdout. Line 1 of stdin is the
config; subsequent lines are mutation responses and control messages. The binary
emits events on stdout.

### Bash

```bash
# Read-only view — no mutations:
CONFIG='{"version":"1","view":"spec","viewsRoot":"/abs/path/to/views","data":{"markdown":"# hi"},"port":0}'
echo "$CONFIG" | ui-leaf mount
# → {"version":"1","type":"ready","url":"http://127.0.0.1:54321","port":54321}
# (browser opens; user closes tab)
# → {"version":"1","type":"disconnected"}
# (mount stays alive; send {"version":"1","type":"close"} on stdin to terminate)
# → {"version":"1","type":"closed","reason":"caller"}
```

The full worked example — including a mutation round-trip with a stateful counter — is
in [`examples/bash/counter.sh`](./examples/bash/counter.sh).

### Python

```python
import subprocess
import json
import sys

config = {
    "version": "1",
    "view": "spend",
    "viewsRoot": "/abs/path/to/views",
    "data": {"items": [], "totals": {}},
    "mutations": ["recategorize"],
    "port": 0,
}

proc = subprocess.Popen(
    ["ui-leaf", "mount"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)

proc.stdin.write(json.dumps(config) + "\n")
proc.stdin.flush()

for line in proc.stdout:
    event = json.loads(line)
    if event["type"] == "ready":
        print(f"view ready at {event['url']}", file=sys.stderr)
    elif event["type"] == "mutate":
        # run the mutation, write back the result
        result = {"type": "result", "id": event["id"], "value": {"ok": True}}
        proc.stdin.write(json.dumps(result) + "\n")
        proc.stdin.flush()
    elif event["type"] == "closed":
        break

proc.wait()
```

See `examples/python/` (coming with v1.0.0) for a fuller example, and
`docs/ipc-protocol.md` (coming with v1.0.0) for the complete message schema.

### Protocol overview

**stdin messages (line-delimited JSON):**

| Message | When |
|---|---|
| Line 1: config object | On spawn — declares view, data, mutations list, and options |
| `{"version":"1","type":"result","id":N,"value":{}}` | Response to a `mutate` event |
| `{"version":"1","type":"error","id":N,"message":"..."}` | Error response to a `mutate` event |
| `{"version":"1","type":"update","data":{}}` | Push new data to the running view |
| `{"version":"1","type":"view","source":"...tsx"}` | Hot-swap the view source |
| `{"version":"1","type":"patch","data":{},"view":{"source":"...tsx"}}` | Atomic data + view swap |
| `{"version":"1","type":"reopen"}` | Re-launch the browser tab after a disconnect |
| `{"version":"1","type":"ping"}` | Caller heartbeat (no reply emitted) |
| `{"version":"1","type":"close"}` | Graceful shutdown |

**stdout events (line-delimited JSON):**

| Event | When |
|---|---|
| `{"version":"1","type":"ready","url":"...","port":N,"id":"..."}` | Server is up — emitted once |
| `{"version":"1","type":"mutate","id":N,"name":"...","args":{}}` | View triggered a mutation — respond on stdin |
| `{"version":"1","type":"disconnected"}` | Browser tab closed; mount stays alive |
| `{"version":"1","type":"reconnected"}` | Browser tab re-opened |
| `{"version":"1","type":"view-swapped"}` | View recompile succeeded (follows `view` or `patch`) |
| `{"version":"1","type":"closed","reason":"caller\|signal\|error"}` | Mount terminated — emitted once, last |
| `{"version":"1","type":"error","phase":"build\|runtime","message":"..."}` | Build error (non-fatal) or runtime error (fatal) |

The binary exits 0 after `closed`, 1 on internal error.

### Tips for non-Node callers

- **Pass `viewsRoot` as an absolute path.** No `cwd/views` default when invoked from
  another process.
- **Pass `port: 0`.** ui-leaf asks the OS for a free port and reports it in the `ready`
  event. Lets you run concurrent views without port collisions.
- **Kill the child on parent shutdown** — close stdin (triggers a `caller` close) or
  send `SIGTERM`. Don't rely on heartbeat alone.
- **Declare every mutation name** in `"mutations": []`. Undeclared names return 404.
- **Tune `heartbeatTimeoutMs`** if the 5000 ms default doesn't fit. The mount does
  not terminate on disconnect — only on `{type:"close"}`, stdin close, or a signal.
  If you want fast shutdown on tab close, listen for `disconnected` and send
  `{type:"close"}` on stdin.
- **Handling concurrent mutations.** Each pending mutation has a unique `id`. Multiple
  mutations can be in flight — match `result`/`error` responses to requests by `id`.

## Architecture: the broker principle

`ui-leaf` enforces a hard separation between the view and the consumer's backend:

```
[CLI / caller]  ──────────── holds credentials, calls backend ──────────► [Backend]
      │                                                                       ▲
      │  spawns                                                               │
      ▼                                                                       │ (never)
[ui-leaf binary]  ◄── mutations ──  [Browser view]                           │
      │                                    │                                  │
      └── data updates ──────────────────► │     fetch("https://…") BLOCKED  ╳
                                           └─────────────────────────────────╯
```

- The CLI holds the credentials. The view never sees auth tokens, never knows the
  backend URL, never touches external state.
- Mutations from the view are named operations declared by the caller. The binary
  routes them to the caller process; the caller calls the backend; the result flows
  back.
- `csp: "strict"` (the default) makes this structural at the browser level:
  `connect-src 'self'` and `form-action 'self'` are set as HTTP response headers.
  The browser refuses any `fetch()` call to a non-loopback origin. The view cannot
  reach an external API even if you (or an AI assistant) accidentally write a `fetch`
  call in the view code.

**Live data updates.** Push new data to a running mount without a reload:

```json
{"version":"1","type":"update","data":{"items":[...],"totals":{}}}
```

The binary forwards it to the browser via a server-sent event; the view re-renders
with in-page state preserved.

**CSP opt-out.** If the view legitimately needs external network access:

```json
{"view": "report", "viewsRoot": "...", "data": {}, "csp": "off"}
```

Or a targeted CSP string:

```json
{"csp": "default-src 'self'; connect-src 'self' https://sentry.io; form-action 'self';"}
```

### DNS-rebinding defence

The server only accepts requests whose `Host` (and `Origin`, when present) header
points at a loopback name — `localhost`, `127.0.0.1`, or `[::1]`. Anything else
gets a 403. This blocks DNS-rebinding attacks where a malicious page swings its
A-record to `127.0.0.1` and tries to reach ui-leaf's token endpoint.

If you reach the server through a custom `/etc/hosts` alias, include it in
`allowedHosts`:

```json
{"allowedHosts": ["my-app.local"]}
```

Be deliberate — every name you add is a potential rebinding target. Don't add public
DNS names or LAN hostnames you don't fully control.

## Security model

### What ui-leaf defends

| Threat | Mechanism |
|---|---|
| Drive-by cross-origin requests from sites the user is browsing | DNS-rebind gate: `Host`/`Origin` header check |
| Other local processes reading the auth token | Token delivered in URL fragment only — never in HTTP response body. Browser bootstrap clears it from the URL bar immediately. Subsequent requests carry it as `X-UI-Leaf-Token` header. |
| View calling the consumer's backend directly | `csp: "strict"` default — browser refuses cross-origin `fetch`, XHR, WebSocket, and form submissions at CSP layer |
| View invoking undeclared mutations | Only mutation names declared in the config are routed; others return 404 from `/mutate` |

### What's out of scope

- **Operator-as-attacker.** A process running as the same user can read ui-leaf's
  memory or attach a debugger. Out of scope.
- **OS URL handler compromise.** A malicious app registered as a browser URL handler
  could intercept the launch URL and read the fragment token before ui-leaf's
  bootstrap clears it. Out of scope.
- **Browser extensions.** An extension with `<all_urls>` permission can read
  `window.location.hash` before the bootstrap runs. Out of scope.
- **SIGKILL data residency.** The tempdir survives SIGKILL until the next mount
  start or OS rotation. Documented limitation.

See `docs/design.md §10` _(coming with v1.0.0)_ for the full security model.

## Sharing views across users

ui-leaf views run on `127.0.0.1`, so the URL in the address bar isn't shareable —
a coworker can't paste `http://127.0.0.1:5810/...` into Slack and have it open on
their machine. The pattern that works: **the consumer CLI generates a deep-link URL
and passes it through `data`. The view renders a "copy share link" button that puts
the deep-link URL on the clipboard.**

```ts
// in the consumer CLI (JS, via the wrapper):
await mount({
  view: "spec",
  data: {
    spec: specContent,
    shareUrl: `mycli://spec/${specId}`,
  },
  mutations: { /* … */ },
});
```

```tsx
// in the consumer's views/spec.tsx:
import type { ViewProps } from "@openthink/ui-leaf/view";

export default function Spec({ data }: ViewProps<{ spec: string; shareUrl: string }>) {
  return (
    <>
      {/* render the spec */}
      <button onClick={() => navigator.clipboard.writeText(data.shareUrl)}>
        Copy share link
      </button>
    </>
  );
}
```

User A clicks the button → `mycli://spec/abc123` is on their clipboard. User B
clicks the link → their OS launches `mycli` → the consumer parses the URL, fetches
the spec on User B's machine, and calls `mount(...)` again. Two independent ui-leaf
invocations, same view, same data — no localhost URL ever leaves either machine.

Pair with `"shell": "app"` in your config to hide the localhost URL bar (Chromium's
chromeless window mode). Safari and Firefox fall back to a regular tab.

The consumer CLI is responsible for (out of ui-leaf's scope):

- **Registering the URL scheme with the OS** at install time:
  - macOS: `CFBundleURLTypes` in `Info.plist`
  - Windows: `HKEY_CLASSES_ROOT\<scheme>` registry entries
  - Linux: `.desktop` file with `MimeType=x-scheme-handler/<scheme>;`
- **Parsing the URL on launch** — when the OS invokes `mycli mycli://spec/abc123`,
  parse it, fetch the spec, build the data, call `mount`.
- **Generating share URLs that are stable IDs**, not raw payloads.
- **Handling "not installed" UX** for links shared with non-users.

## Further reading

- `docs/design.md` _(coming with v1.0.0)_ — architecture deep-dive: repo layout,
  build pipeline, versioning policy, security model
- `docs/ipc-protocol.md` _(coming with v1.0.0)_ — full IPC message schema
  (generated from `packages/cli/schema/ipc.json`)
- [examples/bash/counter.sh](./examples/bash/counter.sh) — runnable Bash example
  with mutation round-trip
- `examples/python/` _(coming with v1.0.0)_ — Python `subprocess` example

## License

[MIT](./LICENSE)
