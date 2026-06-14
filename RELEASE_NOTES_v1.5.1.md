# ui-leaf v1.5.1

A bug-fix release: concurrent `shell:"app"` mounts no longer tear down each other's Chrome window on unmount.

Install:

```bash
npm install @openthink/ui-leaf
# or: bun add @openthink/ui-leaf  /  pnpm add @openthink/ui-leaf
```

The postinstall script detects your platform, downloads the right binary from this release, and verifies its SHA-256 checksum before placing it in `bin/`.

---

## What changed

### Fixed

**Concurrent app-mode mounts could close each other's window (#67).** On POSIX, a mount's teardown signalled the whole **process group** (`kill(-pid, SIGTERM)`). When Chrome's per-profile singleton routes launches through a shared process/group, that group signal could reach a *sibling* mount's Chrome window — so unmounting one app closed another app's window (e.g. a long-lived `sportsball watch` window dying when an unrelated ui-leaf app unmounted).

Teardown is now scoped to the **process tree the mount actually spawned** — the launched pid plus its descendants (Chrome's renderer/gpu/utility helpers) — enumerated from the live process table. A mount's teardown can no longer signal a process it didn't spawn, while still reaping its own helpers (matching the Windows `taskkill /T` tree semantics already in place).

No API or config changes — purely internal teardown behavior.

---

Full commit history is auto-appended below.
