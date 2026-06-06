# ui-leaf v1.2.0

A small feature release: app-mode windows can now open at a caller-specified size, plus a wrapper error-propagation fix.

Install:

```bash
npm install @openthink/ui-leaf
# or: bun add @openthink/ui-leaf  /  pnpm add @openthink/ui-leaf
```

The postinstall script detects your platform, downloads the right binary from this release, and verifies its SHA-256 checksum before placing it in `bin/`.

---

## What changed

### Added

**Initial window size for `shell:"app"` (#56).** Callers can now open the chromeless Chromium window at a specific size instead of the browser default. Pass `windowSize` in the mount config:

```jsonc
// stdio protocol — first line of stdin
{ "version": "1", "view": "...", "viewsRoot": "...", "shell": "app",
  "windowSize": { "width": 1200, "height": 800 } }
```

```js
// JS wrapper
await mount({ view: "dashboard", shell: "app", windowSize: { width: 1200, height: 800 } });
```

It maps to Chromium's `--window-size=W,H`, so the window opens at the right size on first paint rather than snapping via `resizeTo()`. Notes:
- **app mode only** — ignored in `shell:"tab"`.
- Dimensions are CSS pixels; non-finite or non-positive values are ignored with a warning.
- Sets the *initial* size; the user can still resize afterward.

### Fixed

**Wrapper now surfaces the binary's error cause on a pre-ready exit (#58).** When the ui-leaf binary exits before signalling `ready`, the JS wrapper's rejection now carries the underlying error from the binary instead of a generic failure, so callers can see why startup failed.

---

Full commit history is auto-appended below.
