# Changelog

Per-release notes live in `RELEASE_NOTES_vX.Y.Z.md`; this file collects
changes that have landed on `main` but are not yet released.

## Unreleased

### Security

- **Postinstall verifies the binary against checksums pinned in the npm
  package (AGT-2352).** The release workflow copies the binaries'
  `checksums.txt` into `@openthink/ui-leaf` before packing, so the expected
  SHA-256 digests are covered by the tarball's npm provenance. Postinstall
  no longer fetches `checksums.txt` from the GitHub Release, so swapping a
  release binary together with its checksum no longer passes verification.
  A published package missing its pinned `checksums.txt` now fails the
  install instead of trusting the network.
- **Publish workflow hardened (AGT-2354).** Workflow-level permissions are
  empty and each job holds only what it needs. Dependencies are installed
  with `--ignore-scripts`. The npm publish job only downloads a prebuilt
  tarball and publishes it with a pinned npm. The release job no longer
  installs or builds anything while holding `contents: write`. npm publishes
  only after the GitHub Release has its binaries.

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
