# ui-leaf v1.0.0

The first stable release of ui-leaf. This is a clean-break redesign: a self-contained binary, an embeddable IPC protocol, and a thin JS wrapper — no Node required on the end user's machine.

Install:

```bash
npm install @openthink/ui-leaf
# or: bun add @openthink/ui-leaf  /  pnpm add @openthink/ui-leaf
```

The postinstall script detects your platform, downloads the right binary from this release, and verifies its SHA-256 checksum before placing it in `bin/`.

---

## What changed

### Headline architectural changes

**Binary-first distribution.** ui-leaf is now a self-contained executable compiled with `bun build --compile`. Consumers spawn it as a subprocess. The end user's machine does not need Node, Bun, or any other runtime. Five platform binaries are published here:

- `ui-leaf-darwin-arm64`
- `ui-leaf-darwin-x64`
- `ui-leaf-linux-x64`
- `ui-leaf-linux-arm64`
- `ui-leaf-windows-x64.exe`

Each binary's SHA-256 digest appears in `checksums.txt`; the JS wrapper verifies on install.

**Bundler swap: `Bun.build` replaces rsbuild.** The runtime view compiler runs in-process inside the binary. No separate bundler subprocess, no config-file lookups, no native bindings beyond what Bun provides. Write a `.tsx` file; ui-leaf compiles and serves it.

**Library mode dropped.** `import { mount } from '@openthink/ui-leaf'` no longer runs the server in-process. The JS wrapper (`@openthink/ui-leaf`) spawns the binary as a child process and translates events over the stdio IPC protocol. The call signature is compatible with v0.8.x callers; the runtime path is entirely different.

See §3–4 of `docs/design.md` for architecture details.

---

### Default behavior changes

| Setting | v0.8.x default | v1.0.0 default |
|---|---|---|
| `csp` | `"off"` | `"strict"` |
| `heartbeatTimeoutMs` | 75000 | 5000 |
| Auth token delivery | HTML body | URL fragment + `X-UI-Leaf-Token` header |

**CSP `"strict"` by default.** The strict preset locks `default-src 'self'`, `form-action 'self'`, and related directives, enforcing the broker principle at the browser level. Override with `csp: "off"` or a custom CSP string only if your view needs external resources.

**`heartbeatTimeoutMs` 5000ms.** Matches the expected behavior for programmatic consumers that spawn mounts and react to results quickly. Increase if your view is interactive and users may idle.

**Token in URL fragment.** The localhost auth token is passed in the URL fragment (`#token=...`) when the browser opens. A bootstrap script reads and clears it from the URL bar; subsequent requests carry it in the `X-UI-Leaf-Token` header. The token never appears in the HTTP response body.

See §3.4, §10 of `docs/design.md`.

---

### New protocol features (IPC v1)

**Versioned messages.** Every inbound and outbound IPC message now carries `"version": "1"`. Consumers must include this field. The full JSON Schema is published in `schema/ipc.json` and documented in `docs/ipc-protocol.md`.

**New inbound messages:**

| Message | Effect |
|---|---|
| `update` | Push new data to a running mount (no re-spawn required) |
| `view` | Hot-swap the entire view source |
| `patch` | Apply a partial JSON-Patch data update |
| `reopen` | Re-open the browser window if the tab was closed |

**`disconnected` vs `closed`.** `disconnected` fires when the browser tab closes but the mount process is still alive (waiting to reconnect). `closed` fires when the mount process itself terminates. v0.8.x only had `closed`.

**SSE events channel.** `GET /events` streams server-sent events for data-push, view-reload triggers, and close notices. The browser view subscribes and reacts without polling.

See §3.6, §5.1 of `docs/design.md`.

---

### Roadmap

The following are explicitly deferred to v1.1 and later:

- **Detached mounts** — caller exits, mount stays alive. Requires a mount registry (`list`/`send`/`close`/`logs` subcommands) and a unix-socket reconnect path.
- **Language wrappers for Python, Rust, Go** — the IPC schema (`schema/ipc.json`) is designed to support them; only the JS wrapper ships in v1.0.0.
- **HMR** — full reload only in v1.0.0; HMR requires bundler-level support not available in the current stack.
- **Multi-window mounts**
- **Plugin system / advanced CSS pipeline** (PostCSS, Tailwind JIT) — on demand in a v1.x release.

---

## Migration from v0.8.x

1. `npm install @openthink/ui-leaf` — postinstall downloads the binary for your platform.
2. If you are writing a custom protocol consumer (not using the JS wrapper), all IPC messages must include `"version": "1"`.
3. If your view relied on `csp: "off"` default behavior, add `csp: "off"` explicitly to your mount config.
4. Update heartbeat-timeout assumptions if you relied on the 75s default.
5. The token delivery change is transparent for JS wrapper consumers. Raw-protocol consumers should expect the fragment-bootstrap flow.

---

## Checksums

See `checksums.txt` attached to this release.
