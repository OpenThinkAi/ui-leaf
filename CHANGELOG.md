# Changelog

Per-release notes live in `RELEASE_NOTES_vX.Y.Z.md`; this file collects
changes that have landed on `main` but are not yet released.

## Unreleased

### Security

- **Responses are no longer cacheable, and temp Chrome profiles are cleaned
  up (AGT-2354).** Every response from the mount server now carries
  `Cache-Control: no-store, private`, so view HTML and `GET /api/data`
  payloads stay out of the browser's HTTP cache. A `shell: "app"` mount's
  throwaway `ui-leaf-chrome-*` profile in the temp dir is now removed about
  a second after its Chrome exits, and each `shell: "app"` mount sweeps
  leftover `ui-leaf-chrome-*` dirs older than a day that no running Chrome
  holds (left behind when the host exited before Chrome). A persistent
  `profile.dir` is never touched.
- **`debugPort` risk documented (AGT-2351).** The README, `MountOptions`
  docs and the IPC schema now warn that the remote-debugging port has no
  authentication. Any local process gets full DevTools control: it can run
  JavaScript in the page, read cookies and storage, and read the ui-leaf
  token. It must not be combined with a persistent `profile` holding
  sensitive sessions. Behaviour is unchanged.
- **Mount data is never inlined into the served HTML (AGT-2350).** `GET /`
  needs no token, and it used to embed `data` (and every later `update`/
  `patch` payload) in the page. Now the page holds only the view bundle. It
  fetches data from the token-gated `GET /api/data` and receives updates over
  the token-gated `/events` stream, as `dataLoader` mounts already did. A
  local process that reads `GET /` without the token gets no data. The README
  "Sensitive-data callers" note and the `MountOptions` table now match the
  code. The page now makes one extra loopback request before its first
  render; the API is unchanged.
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
