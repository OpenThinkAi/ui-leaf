# ui-leaf

Customizable browser views, on demand, for any CLI.

`ui-leaf` is a self-contained binary. Any program that can spawn a subprocess and
read/write line-delimited JSON on stdio can drive a browser view — Bash scripts,
Python CLIs, Rust tools, Node programs, AI agents. A thin JS wrapper for ergonomic
Node use ships with v1.0.0.

The view is your code — a `.tsx` file in your project's `views/` directory. That's
the **bring-your-own-view** part.

## Status

`v1.0 — stable`. The binary, the stdio protocol, and the JS wrapper API
(`@openthink/ui-leaf`) are all stable. Non-JS wrappers (Python, Rust) are on
the roadmap; today, non-Node callers drive the binary directly over stdio (see
[Quickstart: non-JS callers](#quickstart-non-js-callers)).

> **Upgrading from v0.8.x?** The pre-1.0 package (`@openthink/ui-leaf@0.8.x`)
> was the Node SDK with `mount()`, `dataLoader`, and `ViewProps` exports. v1.0
> replaced the SDK with a thin wrapper that spawns the standalone binary; the
> `mount()` surface is similar but the inside is different. v0.8.x callers
> needing the old API can pin `@openthink/ui-leaf@0.8` — that line is no
> longer maintained.
>
> **Sensitive-data callers (PHI / PCI / financial records):** the v0.8.x SDK
> exposed `dataLoader`, an in-memory alternative to `data` that served the
> payload at a token-gated `/api/data` endpoint instead of inlining it into the
> served HTML. The v1.0 binary's data-update channel uses the same in-memory +
> token-gated posture as a default — the `data` config field is delivered to
> the browser only over the token-gated channel, never inlined into the served
> HTML.

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

### JS wrapper (`npm install @openthink/ui-leaf`)

`npm install @openthink/ui-leaf` installs the thin JS wrapper; `postinstall`
downloads and verifies the right binary for your platform automatically
(SHA256 against the release's `checksums.txt`). API reference for the
wrapper's `mount()` and `View` handle is in
[JS wrapper API](#js-wrapper-api) below.

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

The full worked example — including mutation handling and graceful shutdown — is
in [`examples/python/counter.py`](./examples/python/counter.py). It uses only
the standard library (`asyncio`, `json`, `signal`) and requires Python 3.9+.

### Node (JS wrapper)

```js
import { mount } from "@openthink/ui-leaf";

let count = 0;

const view = await mount({
  view: "counter",
  viewsRoot: "/abs/path/to/views",
  data: { initialCount: count },
  mutations: {
    increment: async ({ by = 1 } = {}) => {
      count += by;
      return { count };
    },
  },
});

console.log(`view ready at ${view.url}`);

// Push updated data to connected browsers (fire-and-forget).
await view.update({ data: { initialCount: count } });

// Wait for the binary to close (browser tab closed or view.close() called).
// `reason` is "caller" | "signal" | "error".
const { reason } = await view.closed;
```

The full worked example — including `view.setView()` and `view.close()` — is
in [`examples/node/counter.js`](./examples/node/counter.js). Run it with
`bun run examples/node/counter.js` (after `bun install`).

The complete message schema is in
[`packages/cli/schema/ipc.json`](./packages/cli/schema/ipc.json).

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
- **Tune `heartbeatTimeoutMs`** if the 15000 ms default doesn't fit. The mount does
  not terminate on disconnect — only on `{type:"close"}`, stdin close, or a signal.
  If you want fast shutdown on tab close, listen for `disconnected` and send
  `{type:"close"}` on stdin.
- **Handling concurrent mutations.** Each pending mutation has a unique `id`. Multiple
  mutations can be in flight — match `result`/`error` responses to requests by `id`.
- **Persist a login across launches.** With `"shell": "app"`, set
  `"profile": { "dir": "/abs/path" }` to give the chromeless window a persistent
  Chrome `--user-data-dir` (created on first use, never deleted on unmount). Use this
  for views behind DRM, SSO, or any session cookie so the user doesn't re-authenticate
  every launch. Omit it (the default) for a throwaway profile. Ignored in tab mode; use
  a distinct `dir` per concurrent app-mode mount.

### Remote / SSH sessions (`UI_LEAF_NO_OPEN`)

Launching a browser only makes sense on a desktop someone is looking at. When a
mount runs inside an SSH session (`SSH_CONNECTION`/`SSH_TTY` set), ui-leaf skips
the launch automatically and instead prints the full launch URL — **including
the `#token=` fragment** — to stderr, plus an `ssh -L` tunnel hint. Without the
fragment the page renders its embedded snapshot but every authed endpoint
(`/mutate`, `/events`, `/api/data`, `/heartbeat`) answers 401, so always copy
the whole URL. The server itself stays loopback-bound; reach it from another
device via SSH port forwarding:

```sh
ssh -L 5810:127.0.0.1:5810 you@host   # then open the printed URL on this device
```

The same behavior is available anywhere by setting `UI_LEAF_NO_OPEN=1`
(any value but `0`/`false`/`no`), and `UI_LEAF_NO_OPEN=0` forces a launch even
under SSH (e.g. when screen-sharing the remote desktop). Consumer CLIs need no
changes: the env var is read by the mount itself, and the notice goes to stderr,
which spawning CLIs typically inherit. Explicit `openBrowser: false` is
different — it means the caller owns the UX, so nothing is printed.

## JS wrapper API

The `@openthink/ui-leaf` package wraps the binary's stdio protocol in an
ergonomic Node API. Install it with `npm install @openthink/ui-leaf` (no
separate binary download — `postinstall` fetches and verifies the right one
for your platform). Requires Node 22+.

For non-Node callers, drive the binary directly over stdio
([Quickstart: non-JS callers](#quickstart-non-js-callers)). The underlying
wire protocol is documented in
[`docs/ipc-protocol.md`](./docs/ipc-protocol.md) — the wrapper is a thin shim
over it, so anything the wrapper does is reproducible from any language.

### `mount(options)`

```js
import { mount } from "@openthink/ui-leaf";

const view = await mount({
  view: "dashboard",
  viewsRoot: "/abs/path/to/views",
  data: { items: [] },
});
```

Spawns the `ui-leaf` binary, sends the config, and resolves with a `View`
handle once the server is `ready`. Rejects if the binary exits before ready
(missing view file, bad config, port unavailable after auto-bump, etc.) —
the rejection's `cause` carries the binary's exit reason.

### `MountOptions`

| Field | Type | Default | Notes |
|---|---|---|---|
| `view` | `string` | _required_ | View name (resolved against `viewsRoot`) — typically the basename of a `.tsx` file under `viewsRoot/`. |
| `viewsRoot` | `string` | _required_ | **Absolute** path to the directory holding view `.tsx` files. |
| `data` | `unknown` | `undefined` | Initial data props for the view. Delivered to the browser over the token-gated channel — never inlined into the served HTML. |
| `mutations` | `Record<string, (args) => Promise<unknown>>` | `{}` | Map of named mutation handlers the view is allowed to call. Keys are declared to the binary as the allowed-mutation list; unknown names return 404. |
| `title` | `string` | `"ui-leaf"` | Browser tab title. |
| `port` | `number` | `5810` | TCP port to bind. Auto-bumps if busy; the bound port is reflected on `view.port`/`view.url`. Pass `0` to let the OS pick. |
| `openBrowser` | `boolean` | `true` | Open the browser when ready. Set `false` for headless / smoke-test use; the URL is still available on `view.url`. Even when `true`, the launch is suppressed by `UI_LEAF_NO_OPEN` or an SSH session (the tokened URL is printed to stderr instead — see [Remote / SSH sessions](#remote--ssh-sessions-ui_leaf_no_open)). |
| `shell` | `"tab"` \| `"app"` | `"tab"` | `"tab"` opens in the user's default browser. `"app"` tries Chromium's `--app` mode (Chrome / Edge / Brave) for a chromeless window; falls back to `"tab"` on Safari, Firefox, or if no Chromium is installed. |
| `windowSize` | `{ width: number; height: number }` | _none_ | Initial Chrome window size in CSS pixels for `shell: "app"`. Ignored in `"tab"` mode. |
| `windowPosition` | `{ x: number; y: number }` | _none_ | Initial Chrome window position in screen CSS pixels for `shell: "app"` (`--window-position=x,y`). Pairs with `windowSize` for tiled / second-screen layouts; coordinates may be negative on multi-monitor setups. Ignored in `"tab"` mode. |
| `extensions` | `string[]` | _none_ | Absolute paths to unpacked Chrome extension dirs to load into the `shell: "app"` window (`--load-extension` + `--disable-extensions-except`), e.g. a content-script overlay on a third-party page. Dirs that don't exist are skipped with a stderr warning. Ignored in `"tab"` mode. **Note:** Chrome 149+ disabled `--load-extension` from the command line — use `debugPort` (CDP) to augment pages on current Chrome. |
| `debugPort` | `number` | _none_ | Opt-in remote-debugging port for `shell: "app"` (`--remote-debugging-port=<n>`, bound to `127.0.0.1`) so a host process can attach over the Chrome DevTools Protocol — e.g. inject an overlay onto a page you don't control via `Page.addScriptToEvaluateOnNewDocument` / `Runtime.evaluate`. Integer 1–65535; loopback-only. If the port is already in use, Chrome launches but may fail to bind the endpoint — pick a free port. Ignored in `"tab"` mode. |
| `profile` | `{ dir: string }` | _none_ | Opt-in persistent browser profile for `shell: "app"`. `dir` is used as Chrome's `--user-data-dir` (created on first use, never deleted on unmount) so login-gated views keep their session across launches. Pass an absolute path; use a distinct `dir` per concurrent app-mode mount. Ignored in `"tab"` mode. |
| `csp` | `"strict"` \| `"off"` \| `string` | `"strict"` | Content-Security-Policy preset. `"strict"` enforces the broker principle in the browser (`connect-src 'self'`, `form-action 'self'`); `"off"` removes the header; a raw string takes full control. |
| `allowedHosts` | `string[]` | `[]` | Extra hostnames accepted in `Host`/`Origin` headers beyond the built-in loopback set (`localhost`, `127.0.0.1`, `[::1]`). Use for `/etc/hosts` aliases; do **not** add public DNS names. |
| `heartbeatTimeoutMs` | `number` | `15000` | Browser silence (ms) after which `disconnected` fires (3× the page's 5s heartbeat, so one late/clamped beat never flaps). Does **not** terminate the mount — only signals. Raise to `>= 65000` for windows kept hidden/minimized > 5 min (Chrome intensive timer throttling). |
| `startupGraceMs` | `number` | `30000` | Grace period (ms) after server start before the heartbeat watcher arms. |
| `signal` | `AbortSignal` | _none_ | Pre-ready abort kills the child; post-ready sends `close` then `SIGKILL` after 5s. The `closed` promise still resolves; check `signal.aborted` to distinguish. |
| `silent` | `boolean` | `false` | Suppress the binary's stderr forwarding to the parent process. Useful when stdout is reserved for a structured protocol. |
| `binaryPath` | `string` | _postinstall-resolved_ | Override the binary path (e.g. a local dev build, or to pin a specific download). Power-user escape hatch. |

### `View` handle

The object resolved by `mount()` is a live handle on the running mount.

| Member | Type | Description |
|---|---|---|
| `url` | `string` | Full URL including the `#token=…` fragment. |
| `id` | `string` | Wrapper-synthetic per-spawn UUID. |
| `port` | `number` | TCP port the server bound to (may differ from the requested port if it auto-bumped). |
| `update({ data })` | `Promise<void>` | Replace the view's `data` props and push a data-updated SSE event to connected browsers. Fire-and-forget (resolves immediately). |
| `setView(source)` | `Promise<void>` | Hot-swap the view source. `source` is **raw TSX** (a code string), not the `view` name. Resolves on the next `view-swapped` event; rejects on build error. (Alias for `setSource(source)`, retained for v1.0.x compatibility.) |
| `patch({ data?, source? })` | `Promise<void>` | Atomic data + view swap. Sends the narrowest wire message for the fields supplied: both → `patch`, source only → `view`, data only → `update`, neither → no-op. |
| `reopen()` | `void` | Re-invoke `open(url)` to launch a fresh browser tab (e.g. after the user closes one). |
| `onDisconnect(handler)` | `void` | Register a handler fired when the browser tab disconnects. May fire multiple times if `reopen()` is used. |
| `onReconnect(handler)` | `void` | Register a handler fired when the browser tab reconnects. |
| `onError(handler)` | `void` | Register a handler for structured error events (`{ phase?, message }`). Build errors are non-fatal; runtime errors are fatal and precede `closed`. |
| `closed` | `Promise<{ reason: string }>` | Resolves when the binary closes, never rejects. `reason` is one of `"caller"` \| `"signal"` \| `"error"`. |
| `close()` | `Promise<void>` | Send `{type:"close"}` and await the `closed` event. Idempotent. |

### Worked example: spend tracker

A two-mutation example — render a list of transactions, let the user
recategorize one, push the recomputed totals back to the view:

```js
import { mount } from "@openthink/ui-leaf";

// Imagine these are loaded from your CLI's data source.
let transactions = [
  { id: "t1", date: "2026-06-01", merchant: "Blue Bottle",     amount:  6.50, category: "uncategorized" },
  { id: "t2", date: "2026-06-02", merchant: "Whole Foods",     amount: 84.20, category: "groceries" },
  { id: "t3", date: "2026-06-03", merchant: "Shell",           amount: 42.10, category: "uncategorized" },
];

function totalsByCategory(rows) {
  return rows.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + r.amount;
    return acc;
  }, {});
}

const view = await mount({
  view: "spend",
  viewsRoot: "/abs/path/to/views",
  title: "Spend",
  data: {
    items: transactions,
    totals: totalsByCategory(transactions),
  },
  mutations: {
    // View calls: mutate("recategorize", { id, category })
    recategorize: async ({ id, category }) => {
      const row = transactions.find((t) => t.id === id);
      if (!row) throw new Error(`unknown transaction: ${id}`);
      row.category = category;
      // Push the recomputed view-state back to the browser.
      await view.update({
        data: {
          items: transactions,
          totals: totalsByCategory(transactions),
        },
      });
      return { ok: true };
    },
  },
});

console.error(`spend view ready at ${view.url}`);

// Optional: auto-reopen if the user closes the tab.
view.onDisconnect(() => view.reopen());

// Block until the mount closes (user calls view.close(), parent gets SIGTERM,
// or a runtime error fires).
const { reason } = await view.closed;
console.error(`spend view closed (${reason})`);
```

For a runnable counter example using the same wrapper API, see
[`examples/node/counter.js`](./examples/node/counter.js).

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

- [`docs/ipc-protocol.md`](./docs/ipc-protocol.md) — human-readable reference
  for the stdio wire protocol (every message type, all optional fields, SSE
  event payloads).
- [`packages/cli/schema/ipc.json`](./packages/cli/schema/ipc.json) — the IPC
  schema (JSON Schema 2020-12). Source of truth for the wire protocol; the
  human-readable doc above is generated from it.
- [JS wrapper API](#js-wrapper-api) — `mount()`, `MountOptions`, and the
  `View` handle reference for `@openthink/ui-leaf`.
- [examples/bash/counter.sh](./examples/bash/counter.sh) — Bash example with
  mutation round-trip (jq preferred; sed fallback for zero-dependency environments).
- [examples/python/counter.py](./examples/python/counter.py) — Python asyncio
  example using only the standard library.
- [examples/node/counter.js](./examples/node/counter.js) — Node/JS example
  using the `@openthink/ui-leaf` wrapper (`mount`, `update`, `setView`, `close`).

## License

[MIT](./LICENSE)

---

Built by [Saltline Digital](https://saltline.digital) — custom software and AI
automation for small businesses.
