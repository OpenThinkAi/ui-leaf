// Chained-promise serialiser used by cli.ts to order view/patch IPC ops.
// Wrapper-js SDK callers have their own queue (enqueueViewOp in
// packages/wrapper-js/src/index.ts); this one protects raw IPC drivers
// (Rust/Go/Python consumers of `ui-leaf mount`) that hit the binary
// directly. Without it, two view/patch messages arriving back-to-back
// would dispatch concurrent Bun.build compiles in different temp dirs and
// last-finisher would clobber viewState.html regardless of arrival order.
//
// Each enqueued op runs to completion (compile + emit) before the next
// starts. Rejections do not break the chain — build errors are non-fatal
// and the next op should still run.

export function createViewOpQueue(): (op: () => Promise<void>) => void {
  let chain: Promise<void> = Promise.resolve();
  return (op) => {
    chain = chain.then(op, op);
  };
}
