# Changelog

Per-release notes live in `RELEASE_NOTES_vX.Y.Z.md`; this file collects
changes that have landed on `main` but are not yet released.

## Unreleased

## 1.7.0 — 2026-10-11

### Fixed

- **`shell: "app"` mounts now end when their Chrome goes away (#101).**
  `closed` resolves — with the new reason `"browser"` — when the launched
  Chrome exits for any reason (⌘Q, SIGTERM, crash). When the last app window
  closes but Chrome lingers with no windows (macOS), ui-leaf notices within
  about 3 seconds, quits that Chrome gracefully, and resolves `closed`. The
  window watch uses a private CDP pipe (`--remote-debugging-pipe`, POSIX
  only), not a network port; a minimized window keeps its page target and is
  never closed. Shutdown signals only the Chrome pid tree the mount spawned,
  never a process group (#67).
- **`ui-leaf mount` no longer orphans when its parent dies (#101).** Besides
  stdin EOF, the binary watches its parent pid and closes (reason `"signal"`)
  once it has been reparented, with a 5s hard-exit deadline. Its app-mode
  Chrome goes down with it: Chrome quits when its CDP pipe disconnects, even
  if ui-leaf-bin is SIGKILLed.

### Changed

- `closed` / `{type:"closed"}` / the `closing` SSE event can carry
  `reason: "browser"`; the binary exits 0 for it. This widens the exported
  `CloseReason` union, so release it as a **minor** bump: TypeScript callers
  with an exhaustive switch (`default: assertNever(reason)`) need a
  `"browser"` arm.
