# ui-leaf v1.5.0

A small feature release: an opt-in remote-debugging port for `shell:"app"`, so a host process can attach over the Chrome DevTools Protocol (CDP).

Install:

```bash
npm install @openthink/ui-leaf
# or: bun add @openthink/ui-leaf  /  pnpm add @openthink/ui-leaf
```

The postinstall script detects your platform, downloads the right binary from this release, and verifies its SHA-256 checksum before placing it in `bin/`.

---

## What changed

### Added

**Remote-debugging port for CDP attach (#66).** Launch the app-mode Chrome window with a DevTools endpoint a host process can attach to:

```jsonc
// stdio protocol — first line of stdin
{ "version": "1", "view": "...", "viewsRoot": "...", "shell": "app",
  "debugPort": 9222 }
```

```js
// JS wrapper / SDK
await mount({ view: "stream", shell: "app", debugPort: 9222 });
```

Maps to Chromium's `--remote-debugging-port=<n>` paired with `--remote-debugging-address=127.0.0.1` (loopback-only). Once attached over CDP you can inject and drive a page you don't control — e.g. `Page.addScriptToEvaluateOnNewDocument` / `Runtime.evaluate` to overlay a companion UI onto a DRM stream — over a live two-way channel.

Notes:
- **app mode only** — ignored in `shell:"tab"`.
- `debugPort` must be an integer in 1–65535; the endpoint is bound to `127.0.0.1`.
- **Why this exists:** Chrome 149 fully disabled `--load-extension` from the command line (the anti-malware lockdown that began ~Chrome 137), which killed the extension path from #64 for augmenting third-party pages. CDP is the remaining injection route and — being the same protocol Puppeteer/Playwright use — isn't subject to that lockdown.

---

Full commit history is auto-appended below.
