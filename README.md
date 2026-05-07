# ui-leaf

Customizable browser views, on demand, for any CLI.

`ui-leaf` is a self-contained binary. Any program that can spawn a subprocess and
read/write line-delimited JSON on stdio can drive a browser view — Bash scripts,
Python CLIs, Rust tools, Node programs, AI agents. A thin JS wrapper for ergonomic
Node use ships with v1.0.0.

The view is your code — a `.tsx` file in your project's `views/` directory. That's
the **bring-your-own-view** part.

## Status

`v1.0.0 — release in progress`. Binary architecture and stdio protocol are stable.
JS wrapper API documentation lands with the publish-target swap (v1.0.0 final). The
full design doc (`docs/design.md`) ships alongside the binary release.

> **On v0.8.x?** The current npm-published package (`@openthink/ui-leaf@0.8.x`) is
> the Node SDK with `mount()`, `dataLoader`, and `ViewProps` exports. Those APIs are
> documented in the README bundled in the npm tarball — install any v0.8.x version
> and read `node_modules/@openthink/ui-leaf/README.md`, or view it on
> [npmjs.com/package/@openthink/ui-leaf](https://www.npmjs.com/package/@openthink/ui-leaf)
> before v1.0.0 publishes. v1.0.0 replaces the SDK with a thin wrapper that spawns
> the standalone binary.
>
> **Sensitive-data callers (PHI / PCI / financial records):** the v0.8.x SDK
> exposes `dataLoader`, an in-memory alternative to `data` that serves the
> payload at a token-gated `/api/data` endpoint instead of inlining it into the
> served HTML. v0.8.x users with that requirement should reach for `dataLoader`
> as documented in the in-tarball README. The v1.0.0 binary's data-update
> channel uses the same in-memory + token-gated posture as a default; explicit
> dataLoader docs ship with v1.0.0.

## Install

### Binary on `$PATH` (v1.0.0, any language)

> Available with the v1.0.0 release. Today's `@openthink/ui-leaf@0.8.x` is the
> Node SDK — see the v0.8.x callout above.

```bash
npm install -g @openthink/ui-leaf
# or: bun add -g @openthink/ui-leaf  /  pnpm add -g @openthink/ui-leaf
```

With v1.0.0, the global install puts the `ui-leaf` binary on your `$PATH`. Use
for Bash, Python, Rust, Go, or any other language — the binary itself has no
Node dependency at runtime (the install path goes through npm's postinstall).

### Direct download (v1.0.0, no Node required)

> Available with the v1.0.0 release. The asset names below are the v1.0.0
> release artifacts; today's `releases/latest` is v0.8.x and ships the SDK
> tarball, not these binaries.

Once v1.0.0 ships, grab the right binary from
[GitHub Releases](https://github.com/OpenThinkAi/ui-leaf/releases/latest):

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | `ui-leaf-darwin-arm64` |
| macOS (Intel) | `ui-leaf-darwin-x64` |
| Linux x64 | `ui-leaf-linux-x64` |
| Linux arm64 | `ui-leaf-linux-arm64` |
| Windows x64 | `ui-leaf-windows-x64.exe` |

Verify the SHA256 against `checksums.txt` from the same release, then make the
binary executable. **No Node.js or other runtime required** — the binary is
fully self-contained.

```bash
# macOS Apple Silicon example:
curl -L -o ui-leaf \
  https://github.com/OpenThinkAi/ui-leaf/releases/latest/download/ui-leaf-darwin-arm64
curl -L -o checksums.txt \
  https://github.com/OpenThinkAi/ui-leaf/releases/latest/download/checksums.txt
grep ui-leaf-darwin-arm64 checksums.txt | shasum -a 256 -c -  \
  && chmod +x ui-leaf  \
  && sudo mv ui-leaf /usr/local/bin/
# (chain with && so a checksum failure aborts the install)
```

### JS wrapper (`npm install @openthink/ui-leaf`, v1.0.0)

With v1.0.0, `npm install @openthink/ui-leaf` will install the thin JS wrapper;
`postinstall` downloads and verifies the right binary for your platform
automatically (SHA256 against the release's `checksums.txt`). Full JS wrapper
API documentation lands with the publish-target swap as part of the v1.0.0
release.

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
        # run the mutation, write back the result (version field required)
        result = {"version": "1", "type": "result", "id": event["id"], "value": {"ok": True}}
        proc.stdin.write(json.dumps(result) + "\n")
        proc.stdin.flush()
    elif event["type"] == "closed":
        break

proc.wait()
```

A fuller Python example ships with v1.0.0 in `examples/python/`. The complete
message schema is in [`packages/cli/schema/ipc.json`](./packages/cli/schema/ipc.json).

### Protocol overview

**Versioning.** Every IPC message carries `"version":"1"` as the first field;
the binary rejects messages without it. This is a v1.0.0 wire-format requirement
and is **not backward-compatible** with the unversioned shape pre-1.0.0 callers
may have used. The schema is published as JSON Schema (see `packages/cli/schema/ipc.json`).

**Auth.** The per-launch random token is delivered to the browser via the
launch URL fragment (`#token=<hex>`) — never inlined into the served HTML. The
browser bootstrap reads it from `window.location.hash`, immediately clears the
fragment via `history.replaceState`, and sends it as an `X-UI-Leaf-Token`
header on subsequent `/mutate`, `/api/data`, and `/events` requests. A local
process that fetches `GET /` cannot recover the token from the response body.

**Default port.** When `port` is omitted from the config, the binary tries
`5810` and auto-bumps if it's busy; the bound port is reported in the `ready`
event. Pass `port: 0` if you want the OS to assign a free port directly
(recommended for concurrent mounts to avoid collisions). Pass an explicit
number if you need a fixed port (e.g. for an OS-registered URL handler).

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
| `{"version":"1","type":"ready","url":"...","port":N}` | Server is up — emitted once |
| `{"version":"1","type":"mutate","id":N,"name":"...","args":{}}` | View triggered a mutation — respond on stdin |
| `{"version":"1","type":"disconnected"}` | Browser tab closed; mount stays alive |
| `{"version":"1","type":"reconnected"}` | Browser tab re-opened |
| `{"version":"1","type":"view-swapped"}` | View recompile succeeded (follows `view` or `patch`) |
| `{"version":"1","type":"closed","reason":"caller\|signal\|error"}` | Mount terminated — emitted once, last |
| `{"version":"1","type":"error","phase":"build\|runtime","message":"..."}` | Build error (non-fatal) or runtime error (fatal) |

The binary exits 0 after `closed`, 1 on internal error.

For the full field-by-field reference — including every message type, all optional fields, and SSE event payloads — see [`docs/ipc-protocol.md`](./docs/ipc-protocol.md).

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
      └── data updates ──────────────────► │     fetch("https://…") BLOCKED
                                           └──────────────────────────────────
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

**CSP opt-out.** If the view legitimately needs external network access, add a `csp`
key to the config object:

```json
{"version": "1", "view": "report", "viewsRoot": "...", "data": {}, "csp": "off"}
```

Or a targeted CSP string:

```json
{"version": "1", "view": "report", "viewsRoot": "...", "data": {},
 "csp": "default-src 'self'; connect-src 'self' https://sentry.io; form-action 'self';"}
```

### DNS-rebinding defence

The server only accepts requests whose `Host` (and `Origin`, when present) header
points at a loopback name — `localhost`, `127.0.0.1`, or `[::1]`. Anything else
gets a 403. This blocks DNS-rebinding attacks where a malicious page swings its
A-record to `127.0.0.1` and tries to reach ui-leaf's token endpoint.

If you reach the server through a custom `/etc/hosts` alias, include it in
`allowedHosts`:

```json
{"version": "1", "view": "...", "viewsRoot": "...", "data": {},
 "allowedHosts": ["my-app.local"]}
```

Be deliberate — every name you add is a potential rebinding target. Don't add public
DNS names or LAN hostnames you don't fully control.

## Security model

The mechanisms below describe **v1.0.0 behavior**. The v0.8.x SDK has a
narrower posture — its README documents what's enforced in that release.

### What ui-leaf defends (v1.0.0)

| Threat | Mechanism |
|---|---|
| Drive-by cross-origin requests from sites the user is browsing | DNS-rebind gate: `Host`/`Origin` header check |
| Other local processes reading the auth token | Token delivered in URL fragment only — never in HTTP response body. Browser bootstrap clears it from the URL bar immediately. Subsequent requests carry it as `X-UI-Leaf-Token` header (covers `fetch`, `XHR`, WebSocket — `connect-src` in CSP terms — and form submissions via `form-action`). |
| View calling the consumer's backend directly | `csp: "strict"` default — browser refuses cross-origin `fetch`, XHR, WebSocket, and form submissions at CSP layer. **Turning CSP off** (`csp: "off"`) re-opens the broker bypass: views can call any backend they want, defeating the broker principle. Use only when external network access is genuinely intended. |
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

The full security model ships as part of the v1.0.0 design doc release.

## Sharing views across users

ui-leaf views run on `127.0.0.1`, so the URL in the address bar isn't shareable —
a coworker can't paste `http://127.0.0.1:5810/...` into Slack and have it open on
their machine. The pattern that works: **the consumer CLI generates a deep-link URL
and passes it through `data`. The view renders a "copy share link" button that puts
the deep-link URL on the clipboard.**

In JS via the v1.0.0 wrapper (full API docs ship with v1.0.0 final):

```ts
await mount({
  view: "spec",
  data: {
    spec: specContent,
    shareUrl: `mycli://spec/${specId}`,
  },
  mutations: { /* … */ },
});
```

From any other language, the equivalent is the stdin config: pass `shareUrl`
inside `data`, the view reads it the same way.

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

- [`packages/cli/schema/ipc.json`](./packages/cli/schema/ipc.json) — the IPC
  schema (JSON Schema 2020-12). Source of truth for the wire protocol. A
  human-readable doc generated from this schema (`docs/ipc-protocol.md`) and a
  fuller architecture deep-dive (`docs/design.md`) ship as part of the v1.0.0
  release.
- [examples/bash/counter.sh](./examples/bash/counter.sh) — runnable Bash example
  with mutation round-trip. A Python `subprocess` example ships with v1.0.0.

## License

[MIT](./LICENSE)
