# ui-leaf

Customizable browser views, on demand, for any CLI.

```bash
npm install ui-leaf
# or: bun add ui-leaf / pnpm add ui-leaf / yarn add ui-leaf
```

## What it is

`ui-leaf` lets any CLI mount a local browser view from a single function call. The CLI pipes structured data in; the view renders it; user-driven mutations (button clicks, edits, deletes) flow **back through the CLI** as plain function calls — never directly to whatever backing API the CLI uses.

The view is your code, in your project's `views/` folder. Customize it, regenerate it with an LLM, fork the defaults — it's a regular `.tsx` file. That's the **bring-your-own-view** part.

## Quickstart

```ts
// my-cli/src/commands/spend.ts
import { mount } from "ui-leaf";

const view = await mount({
  view: "spend",
  data: { items: [/* ... */], totals: {/* ... */} },
  mutations: {
    recategorize: async (args: { id: string; category: string }) => {
      await db.recategorize(args.id, args.category);
      return { ok: true };
    },
  },
});

console.log(`view at ${view.url} — close the tab to exit`);
await view.closed;
```

```tsx
// my-cli/views/spend.tsx
import type { ViewProps } from "ui-leaf/view";

interface Spend {
  items: { id: string; amount: number; category: string }[];
  totals: { total: number };
}

export default function Spend({ data, mutate }: ViewProps<Spend>) {
  return (
    <main>
      <h1>${data.totals.total}</h1>
      <ul>
        {data.items.map((item) => (
          <li key={item.id}>
            {item.amount} — {item.category}
            <button
              onClick={() => mutate("recategorize", { id: item.id, category: "food" })}
            >
              → food
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

Run `my-cli spend` (or whatever `--ui` flag your CLI uses) and a browser tab opens with the view rendering your data. Click a button, the CLI's `recategorize` handler runs, the result flows back to the view as a resolved promise.

## Why route mutations through the CLI?

Three reasons:

1. **The CLI already has the credentials.** Your view never sees auth tokens, never knows the API endpoint, never has to deal with refresh logic. The CLI handles all of that and exposes a constrained set of named operations.
2. **The CLI can do work the view can't.** Read local files, shell out, check the user's git state, write to a SQLite file, anything Node can do.
3. **The view is replaceable, the contract isn't.** Users can fork and rewrite the view freely; what they can't do is reach around the CLI to call your API directly.

## How it works

`mount()` spins up a local dev server (rsbuild + React under the hood), bundles your view file, injects the data into `window.__UI_LEAF__.data`, and opens the user's default browser. Mutations from the view POST back to a localhost endpoint with a per-launch random token; the runtime dispatches them to the handlers you registered. Browser tab close → heartbeat stops → server shuts down → `view.closed` resolves and your CLI continues.

The transport is HTTP + JSON over loopback. The token is in `window.__UI_LEAF__.token`, and it's served inline in the HTML at `/index.html` — so the token only protects against drive-by cross-origin requests in the user's browser, not against other processes on the same machine. Any local process that can reach `127.0.0.1:<port>` can fetch the page, grep the token out, and call `/mutate` with it; treat any local process you don't trust as having the same access as the view. View bundling resolves React from `ui-leaf`'s installed location, so your project doesn't need to install React.

## API surface

```ts
import { mount } from "ui-leaf";
import type { ViewProps, MutationHandler } from "ui-leaf/view";

await mount({
  view,                                      // resolves <viewsRoot>/<view>.tsx
  data,                                      // JSON-serializable, becomes data prop
  mutations,                                 // Record<string, MutationHandler> (optional)
  viewsRoot,                                 // optional, default: <cwd>/views
  title,                                     // optional, default: "ui-leaf"
  port,                                      // optional, default: 5810 (auto-bumps if busy)
  openBrowser,                               // optional, default: true
  shell,                                     // optional, "tab" | "app", default: "tab"
  csp,                                       // optional, default: "off" (see Hardening)
  silent,                                    // optional, default: false (see Programmatic use)
  signal,                                    // optional AbortSignal
  heartbeatTimeoutMs,                        // optional, default: 75000
  startupGraceMs,                            // optional, default: 30000
});
```

(This is a summary — see the JSDoc on `MountOptions` for the full TypeScript shape and per-field rationale.)

Returns `{ url, port, closed, close }`.

## Hardening: locking the data/mutation contract with CSP

By default, the data/mutation routing is **convention, not enforcement** — a view file is JavaScript in a browser tab and can `fetch()` anywhere it likes. Most consumers don't need more than that.

When you do want to enforce it (typically: views handle data sensitive enough that you don't want a forked view to be able to exfiltrate it), opt in via `csp`:

```ts
mount({
  view: "report",
  data: { ... },
  csp: "strict",   // or a custom CSP string for full control
});
```

`csp: "strict"` ships a balanced preset that:

- **Locks `connect-src` to same-origin** — the architectural lock. Views cannot fetch external APIs; all data flows through `data` and `mutations`.
- **Permits HTTPS images and fonts** so views can load CDN assets normally.
- **Allows inline styles, eval, and inline scripts** for React + rsbuild's HMR.

Because the policy is sent as an HTTP response header, views cannot relax it at runtime. The only way to weaken the policy is to change the `mount()` call (i.e. fork the consumer CLI, not the view).

If the preset is too strict for your case (e.g. you need to allow Sentry telemetry), pass a raw CSP string:

```ts
csp: "default-src 'self'; connect-src 'self' https://sentry.io; img-src 'self' https:;"
```

### DNS-rebinding defence

The dev server only accepts requests whose `Host` (and `Origin`, when sent) header points at a loopback name — `localhost`, `127.0.0.1`, or `[::1]`. Anything else gets a 403. This blocks DNS-rebinding attacks where a malicious page swings its A-record to `127.0.0.1` and tries to talk to your dev server with the per-launch auth token it can read out of `/index.html`.

If you reach the dev server through a custom `/etc/hosts` alias (e.g. `my-app.local → 127.0.0.1`), pass it through `allowedHosts`:

```ts
mount({
  view: "report",
  data: { ... },
  allowedHosts: ["my-app.local"],
});
```

Be deliberate — every name you add becomes a viable rebinding target. Don't add public DNS names or wildcards.

## Sharing views across users

ui-leaf views run on `127.0.0.1`, so the URL in the address bar isn't shareable — a coworker can't paste `http://127.0.0.1:5810/...` into Slack and have it open on their machine. Browsers also can't be made to *display* a custom protocol like `mycli://...` for an HTTP-served page (browser security: any HTTP page could spoof itself otherwise).

The pattern that works: **the consumer CLI generates a deep-link URL and passes it through `data`. The view renders a "copy share link" button that puts that deep-link URL on the clipboard.**

```ts
// in the consumer CLI:
await mount({
  view: "spec",
  data: {
    spec: specContent,
    shareUrl: `mycli://spec/${specId}`,
  },
  mutations: { /* … */ },
});
```

```tsx
// in the consumer's views/spec.tsx:
import type { ViewProps } from "ui-leaf/view";

export default function Spec({ data }: ViewProps<{ spec: string; shareUrl: string }>) {
  return (
    <>
      {/* render the spec */}
      <button onClick={() => navigator.clipboard.writeText(data.shareUrl)}>
        Copy share link
      </button>
    </>
  );
}
```

Pair with `shell: "app"` (Chromium's chromeless window mode) to hide the localhost URL bar entirely on Chrome/Edge/Brave — the share button becomes the *only* way to copy a link from the view. (Safari and Firefox fall back to a regular tab.)

User A clicks the button → `mycli://spec/abc123` is on their clipboard. User B clicks the link → their browser hands off to the OS → OS launches `mycli` (because it's registered as the `mycli://` handler) → the consumer parses the URL, fetches the spec on their machine, calls `mount(...)` again on User B's side. Two independent ui-leaf invocations, same view, same data, no localhost URL ever leaves either machine.

What the consumer CLI is responsible for (out of ui-leaf's scope):

- **Registering the URL scheme with the OS** at install time. Per-OS:
  - macOS: `.app` bundle with `CFBundleURLTypes` in `Info.plist`
  - Windows: registry entries under `HKEY_CLASSES_ROOT\<scheme>`
  - Linux: `.desktop` file with `MimeType=x-scheme-handler/<scheme>;`
- **Parsing the URL on launch** — when the OS invokes `mycli mycli://spec/abc123`, parse it, look up `abc123`, build the data, call `mount`.
- **Generating share URLs that are stable IDs**, not raw payloads — URLs land in browser history, screenshots, and copy-paste; treat them accordingly.
- **Handling "not installed" UX** in the originating web app (if the link gets shared with someone who doesn't have `mycli`) — typical pattern is to set `window.location` to the deep-link URL, then after a short timeout fall back to "looks like you don't have mycli installed, here's how to get it."

## Driving ui-leaf from a non-Node CLI (Rust / Go / Python / shell)

`ui-leaf mount` is a language-neutral binary. Any CLI that can spawn a subprocess and read/write JSON lines on stdio can drive ui-leaf with no Node code of its own — install ui-leaf via `npm i -g ui-leaf` (or bundle it), and shell out to `ui-leaf mount`.

### Protocol

- **stdin (line-delimited JSON):**
  - **Line 1** — config:
    ```json
    {"view":"spec","viewsRoot":"/abs/path","data":{},"mutations":["refresh","dismiss"],"port":0,"openBrowser":true,"heartbeatTimeoutMs":5000}
    ```
  - **Subsequent lines** — mutation responses (paired by `id`):
    ```json
    {"type":"result","id":1,"value":{"ok":true}}
    {"type":"error","id":2,"message":"…"}
    ```
- **stdout (line-delimited JSON):**
  - `{"type":"ready","url":"http://127.0.0.1:54321","port":54321}` — emitted once when the dev server is up
  - `{"type":"mutate","id":1,"name":"refresh","args":{}}` — emitted when a view triggers a mutation; respond on stdin
  - `{"type":"closed"}` — emitted on natural close (browser tab closed, heartbeat timeout)
  - `{"type":"error","message":"…"}` — emitted on internal failure
- **Lifecycle:** binary exits 0 on natural close, 1 on internal error; closing stdin from the parent triggers shutdown.

### Minimal Bash example (read-only view, no mutations)

```bash
CONFIG='{"view":"spec","viewsRoot":"/abs/path/to/views","data":{"markdown":"# hi"},"port":0}'
echo "$CONFIG" | ui-leaf mount
# → {"type":"ready","url":"http://127.0.0.1:54321","port":54321}
# (browser opens; user closes tab)
# → {"type":"closed"}
```

### Worked example with mutations

When the view calls `mutate("name", args)`, the binary emits a `mutate` event on stdout and waits for the parent to write back a `result` (or `error`) on stdin, paired by `id`. The runnable script in [`examples/bash/counter.sh`](./examples/bash/counter.sh) demonstrates the full cycle. Sketch:

```
Parent → child stdin:
  {"view":"demo","viewsRoot":"/abs/path","data":{"initialCount":0},"mutations":["increment"]}

Child → parent stdout:
  {"type":"ready","url":"http://127.0.0.1:54321","port":54321}

(user clicks "+1" in the view)

Child → parent stdout:
  {"type":"mutate","id":1,"name":"increment","args":{"by":1}}

Parent → child stdin (after handling the mutation):
  {"type":"result","id":1,"value":{"count":1}}

(user closes tab)

Child → parent stdout:
  {"type":"closed"}
```

Each pending mutation has a unique `id`. Multiple mutations can be in flight concurrently — match `result`/`error` responses by id.

### Tips for non-Node consumers

- **Pass `viewsRoot` as an absolute path.** No `cwd/views` default games when invoked from another process.
- **Pass `port: 0`.** ui-leaf asks the OS for a free port and reports it back in the `ready` event. Lets you run concurrent views without collision.
- **Lower `heartbeatTimeoutMs`** (e.g. 5000) so orphaned ui-leaf children exit fast if your parent process dies. The default 75000 is tuned for human-direct use (survives one browser background-tab throttle) and is too long when a parent process is supervising.
- **Kill the child on parent shutdown** rather than relying on heartbeat — `kill <pid>` from the parent. Closing stdin also triggers a clean shutdown.
- **Declare every mutation name** the view will call in the `mutations: []` array. The binary only routes mutations whose names appear in the list; calls to undeclared names get a 404 from `/mutate` with the standard "no mutation handler registered for X" error, and the view's `mutate()` promise rejects.

### Driving from Node via `mount()` directly

If your consumer is itself Node (or you want a thin in-process integration), use the SDK directly. Pass `silent: true` to suppress rsbuild output so you can keep stdout clean for your own protocol (capture `process.stdout.write` *before* calling `mount()`, since the option redirects stdout to stderr for the lifetime of the dev server):

```ts
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const view = await mount({
  view: "spec",
  viewsRoot: "/abs/path/to/views",
  data: { /* ... */ },
  openBrowser: false,
  silent: true,
  port: 0,
});
realStdoutWrite(JSON.stringify({ type: "ready", url: view.url, port: view.port }) + "\n");
```

## Status

`0.2.x` — pre-1.0, expect churn. The Node SDK and the `ui-leaf mount` binary are settling but not frozen.

## License

[MIT](./LICENSE)
