// Internal-only teardown with an explicit close reason (ui-leaf#101).
//
// `MountedView.close()` is public and always means "the caller closed it".
// The stdio binary also needs to report *why* it tore a mount down — e.g.
// "signal" when its parent process died — without putting a `reason`
// parameter on the public SDK surface. index.ts registers each mount's
// reason-aware closer here; cli.ts looks it up. Not re-exported from index.

import type { CloseReason } from "../ipc.js";

const closers = new WeakMap<object, (reason: CloseReason) => Promise<void>>();

export function registerCloseWithReason(
  view: object,
  close: (reason: CloseReason) => Promise<void>,
): void {
  closers.set(view, close);
}

/** Close `view` reporting `reason`; falls back to a plain caller close. */
export function closeWithReason(
  view: { close: () => Promise<void> },
  reason: CloseReason,
): Promise<void> {
  const close = closers.get(view);
  return close ? close(reason) : view.close();
}
