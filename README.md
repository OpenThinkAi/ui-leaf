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

The transport is HTTP + JSON over loopback. The token is in `window.__UI_LEAF__.token`. Other processes on the same machine can't make valid mutation calls without it. View bundling resolves React from `ui-leaf`'s installed location, so your project doesn't need to install React.

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

## Programmatic use (driving ui-leaf from a subprocess)

If you're calling `mount()` from a Node bridge that another process is spawning — e.g. a Rust / Go / Python / shell-script CLI shelling out to a small `bridge.js` you maintain — you'll want to keep stdout clean for your own protocol.

By default, ui-leaf and rsbuild write banner / build / deprecation lines to stdout. That collides with line-delimited JSON or any other structured channel a parent process is reading. Pass `silent: true`:

```ts
import { mount } from "ui-leaf";

// Capture the *real* stdout reference BEFORE mount() redirects it.
const realStdoutWrite = process.stdout.write.bind(process.stdout);

const view = await mount({
  view: "spec",
  viewsRoot: "/abs/path/to/views",
  data: { /* ... */ },
  openBrowser: false,                  // parent decides when to open
  silent: true,                        // suppress rsbuild noise on stdout
  port: 0,                             // let OS pick a free port
});

// Now write your own protocol on the real stdout.
realStdoutWrite(JSON.stringify({ type: "ready", url: view.url, port: view.port }) + "\n");

await view.closed;
realStdoutWrite(JSON.stringify({ type: "closed" }) + "\n");
```

Other tips for programmatic consumers:

- **Pass `viewsRoot` explicitly.** The default is `<cwd>/views`, which is wrong for a bridge invoked from a different working directory.
- **Pass `port: 0`.** Lets the OS pick a free port and report it back via `view.port`. The default `5810` is for human-direct use; concurrent invocations would otherwise conflict.
- **Lower `heartbeatTimeoutMs`** (e.g. to 5000) when the bridge is the supervisor. The default 75-second window survives browser-tab throttling for human use, but is too long when the parent process dies and you want orphaned ui-leaf children to exit fast.
- **Kill the child explicitly on parent shutdown** rather than relying on heartbeat timeout — `process.kill(child.pid)` from your spawning code.

A working reference bridge for Rust consumers lives at [`OpenThinkAi/open-audit/bridges/ui-leaf`](https://github.com/OpenThinkAi/open-audit/tree/main/bridges/ui-leaf). A first-class language-neutral binary (`ui-leaf mount …`) that internalizes this pattern is on the roadmap (Spike #4).

## Status

`0.1.x` — pre-1.0, expect churn. The public API shape is settling but not frozen.

## License

[MIT](./LICENSE)
