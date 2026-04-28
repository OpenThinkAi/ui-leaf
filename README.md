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
  csp,                                       // optional, default: "off" (see Hardening)
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

## Status

`0.1.x` — pre-1.0, expect churn. The public API shape is settling but not frozen.

## License

[MIT](./LICENSE)
