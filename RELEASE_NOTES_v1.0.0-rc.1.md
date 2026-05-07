# ui-leaf v1.0.0-rc.1

This is a release candidate for v1.0.0. It represents a clean break from the v0.x SDK-style distribution. If no regressions surface from smoke testing across all five platforms, the final v1.0.0 cut will follow.

**This is a prerelease.** Install via the `next` tag: `npm install @openthink/ui-leaf@next`.

## What's in v1.0.0

### Binary-first distribution

ui-leaf is now a self-contained executable, not a Node library. Consumers spawn it as a subprocess. The end user's machine does not need Node, Bun, or any other runtime.

Five platform binaries are published to GitHub Releases:
- `ui-leaf-darwin-arm64`
- `ui-leaf-darwin-x64`
- `ui-leaf-linux-x64`
- `ui-leaf-linux-arm64`
- `ui-leaf-windows-x64.exe`

Each release also includes a `checksums.txt` with SHA-256 digests verified by the JS wrapper on install.

### JS wrapper (`@openthink/ui-leaf`)

The npm package is now a thin wrapper, not the binary itself. On `npm install`, the postinstall script detects your platform, downloads the right binary from GitHub Releases, verifies its SHA-256 checksum, and places it in `bin/`. The `mount()` API spawns the binary as a child process and translates events to/from the IPC protocol.

### Bundler swap: `Bun.build` replaces rsbuild

The runtime view compiler is now `Bun.build`, running in-process inside the binary. No separate bundler subprocess, no config-file lookups, no native bindings beyond what Bun provides. Write a `.tsx` file, ui-leaf compiles it, browser renders it.

### Versioned IPC protocol (v1)

Every inbound and outbound message now carries `"version": "1"`. New inbound messages:

- `update` — push new data to a running mount (no re-spawn)
- `view` — hot-swap the entire view source
- `patch` — apply a partial data update
- `reopen` — re-open the browser window if it was closed

### Disconnected vs closed

`disconnected` fires when the browser tab closes but the mount process is still alive (waiting to reconnect). `closed` fires when the mount process itself terminates. v0.x only had `closed`.

### SSE events channel

`GET /events` streams server-sent events for data-push, view-reload triggers, and close notices. The browser view subscribes and reacts without polling.

### Security: token in URL fragment

The localhost auth token is no longer served in the HTML body. It is passed in the URL fragment (`#token=...`) when the browser opens. A bootstrap script reads and clears it from the URL bar; subsequent requests include it via `X-UI-Leaf-Token`. Any process reading the HTTP response body cannot observe the token.

### Security: CSP `strict` by default

`csp` now defaults to `"strict"` instead of `"off"`. The strict preset locks `default-src 'self'`, `form-action 'self'`, and related directives, enforcing the broker principle at the browser level. Opt out with `csp: "off"` or a custom CSP string if your view needs to reach external resources.

### Heartbeat timeout: 5000ms default

`heartbeatTimeoutMs` defaults to 5000ms (down from 75000ms). This matches the expected behavior for non-interactive consumers that spawn mounts programmatically.

## Migration from v0.x

v1.0.0 is a **clean break**. The library-mode API (`import { mount } from '@openthink/ui-leaf'`) still works through the JS wrapper but now spawns the binary subprocess — the call signature is compatible, but the runtime behavior is different. If you were importing internal modules or depending on the rsbuild pipeline directly, those are gone.

1. `npm install @openthink/ui-leaf@1.0.0-rc.1` — postinstall downloads the binary for your platform.
2. IPC messages must include `"version": "1"` on every message if you are writing a custom protocol consumer.
3. If your view relied on the default `csp: "off"` behavior, add `csp: "off"` explicitly to your mount config.
4. Update any heartbeat-timeout assumptions if you relied on the 75s default.

See the full design at [`docs/design.md`](docs/design.md).

## Smoke test status

This rc is being validated across all five platform binaries. Results will be recorded before the v1.0.0 final cut (AGT-141).
