# ui-leaf v1.8.0

A security release. One behaviour change can break existing views: read the first section before upgrading.

Install:

```bash
npm install @openthink/ui-leaf
# or: bun add @openthink/ui-leaf  /  pnpm add @openthink/ui-leaf
```

The postinstall script detects your platform, downloads the right binary from this release, and verifies its SHA-256 against the `checksums.txt` pinned inside the npm package.

---

## Behaviour change: `csp: "strict"` no longer allows external images, fonts or stylesheets

`csp: "strict"` is the default. Until now it allowed images, fonts and stylesheets from any `https:` origin, which let view code send data out in an image or stylesheet URL even though `connect-src` was locked to the ui-leaf server.

From 1.8.0, strict loads images, fonts and stylesheets only from the ui-leaf server itself or from inline `data:`/`blob:` URLs, and sends `frame-ancestors 'none'` in the response header.

**What you must do:** if your view loads anything from an external origin (Google Fonts, an icon CDN, remote images), it is now blocked under the default. Pick one:

- Pass `csp: "external-assets"`, a new preset that keeps the old strict behaviour (any HTTPS image, font or stylesheet; `connect-src` and `form-action` still locked to the server).
- Better, pass a raw CSP string that names the exact origins you need.
- Or bundle the assets into the view (inline `data:` URLs work under strict).

Views that load nothing external need no change.

```js
await mount({ view: "report", viewsRoot, data, csp: "external-assets" });
```

```json
{"version":"1","view":"report","viewsRoot":"...","data":{},"csp":"external-assets"}
```

---

## Other changes

### Security

- **Responses are not cached.** Page and data responses from the mount server carry `Cache-Control: no-store, private`, so view HTML and `GET /api/data` payloads stay out of the browser's HTTP cache.
- **Temp Chrome profiles are removed.** A `shell: "app"` mount's throwaway `ui-leaf-chrome-*` profile is deleted about a second after its Chrome exits, and each `shell: "app"` mount sweeps leftover `ui-leaf-chrome-*` dirs older than a day that no running Chrome holds. A persistent `profile.dir` is never touched.
- **Mount data is never inlined into the served HTML.** `GET /` needs no token and now carries only the view bundle. The page fetches its data from the token-gated `GET /api/data` and receives `update`/`patch` data over the token-gated `/events` stream. A local process reading `GET /` without the token gets no data. The page makes one extra loopback request before first render; the API is unchanged.
- **Binary checksums are pinned into the npm package.** Postinstall verifies the downloaded binary against the `checksums.txt` shipped inside the tarball (covered by npm provenance), not the copy on the GitHub Release. A package missing its pinned checksums fails the install rather than trusting the network.
- **`debugPort` risk documented.** The remote-debugging port has no authentication: any local process gets full DevTools control, including the ui-leaf token. Don't combine it with a persistent `profile` holding sensitive sessions. Behaviour unchanged.
- **Publish workflow hardened.** Per-job least-privilege permissions, dependency installs with `--ignore-scripts`, and the npm publish job only publishes a prebuilt tarball, after the GitHub Release has its binaries.

### Docs

- README install section no longer describes the binaries as upcoming; the security table lists the mount-data protections.
- `ui-leaf mount --help` shows a config example with the required `"version":"1"` field and links to the correct README section.

### For contributors

- Stay on TypeScript 6. tsup's declaration (`dts`) build breaks on TypeScript 7.

---

Full commit history is auto-appended below.
