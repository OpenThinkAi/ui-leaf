# ui-leaf v1.4.0

A small feature release: two more opt-in `shell:"app"` launch controls — initial window position and unpacked Chrome extensions — for second-screen and overlay/companion layouts.

Install:

```bash
npm install @openthink/ui-leaf
# or: bun add @openthink/ui-leaf  /  pnpm add @openthink/ui-leaf
```

The postinstall script detects your platform, downloads the right binary from this release, and verifies its SHA-256 checksum before placing it in `bin/`.

---

## What changed

### Added

**Initial window position for `shell:"app"` (#65).** Pairs with `windowSize` (#56) so a window can open at specific screen coordinates instead of Chrome's default placement — handy for second-screen / tiled layouts:

```jsonc
// stdio protocol — first line of stdin
{ "version": "1", "view": "...", "viewsRoot": "...", "shell": "app",
  "windowSize": { "width": 1200, "height": 800 },
  "windowPosition": { "x": 100, "y": 60 } }
```

```js
// JS wrapper / SDK
await mount({ view: "stats", shell: "app",
  windowSize: { width: 1200, height: 800 },
  windowPosition: { x: 100, y: 60 } });
```

Maps to Chromium's `--window-position=x,y`. Coordinates are CSS pixels and **may be negative** (a monitor to the left of / above the primary); non-finite values are ignored with a warning. App mode only — ignored in `shell:"tab"`.

**Load unpacked Chrome extensions for `shell:"app"` (#64).** Load one or more unpacked extensions into the launched window — e.g. a content-script overlay on a third-party (DRM, un-iframable) page:

```jsonc
{ "version": "1", "view": "...", "viewsRoot": "...", "shell": "app",
  "extensions": ["/abs/path/to/unpacked-extension"] }
```

```js
await mount({ view: "overlay", shell: "app",
  extensions: ["/abs/path/to/unpacked-extension"] });
```

Maps to Chromium's `--load-extension=<dirs>` + `--disable-extensions-except=<dirs>`. Notes:
- **app mode only** — ignored in `shell:"tab"`.
- Use absolute paths. Dirs that don't exist are skipped with a stderr warning rather than silently loading nothing.
- Pairs naturally with the persistent `profile` (#63) when the overlay needs a logged-in session underneath.

---

Full commit history is auto-appended below.
