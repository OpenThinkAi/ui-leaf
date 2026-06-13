# ui-leaf v1.3.0

A small feature release: `shell:"app"` views can now use an opt-in persistent browser profile so login-gated views keep their session across launches.

Install:

```bash
npm install @openthink/ui-leaf
# or: bun add @openthink/ui-leaf  /  pnpm add @openthink/ui-leaf
```

The postinstall script detects your platform, downloads the right binary from this release, and verifies its SHA-256 checksum before placing it in `bin/`.

---

## What changed

### Added

**Persistent browser profile for `shell:"app"` (#63).** By default each mount launches Chrome with a throwaway `--user-data-dir` that is discarded on unmount, so any login-gated view (DRM streaming, SSO dashboards, anything behind a session cookie) re-authenticates every launch. You can now point Chrome at a persistent profile that survives across launches:

```jsonc
// stdio protocol — first line of stdin
{ "version": "1", "view": "...", "viewsRoot": "...", "shell": "app",
  "profile": { "dir": "/abs/path/to/profile" } }
```

```js
// JS wrapper / SDK
await mount({ view: "stream", shell: "app", profile: { dir: "/abs/path/to/profile" } });
```

The directory is created on first use, used as Chrome's `--user-data-dir`, and **never deleted** on unmount, so the logged-in session is reused next launch. Notes:
- **app mode only** — ignored in `shell:"tab"` (the default browser owns its own profile there).
- Default (no `profile`) keeps the existing throwaway-temp behavior exactly.
- A persistent dir is a named profile, so two concurrent mounts pointed at the same `dir` share one Chrome process (single-instance lock) rather than getting isolated windows — use a distinct `dir` per concurrent app-mode mount.

---

Full commit history is auto-appended below.
