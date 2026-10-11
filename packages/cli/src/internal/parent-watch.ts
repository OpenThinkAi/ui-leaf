// Detect that the process which spawned `ui-leaf mount` has died
// (ui-leaf#101).
//
// Stdin EOF is the primary signal, but it never arrives when another process
// still holds the write end of our stdin pipe (an inherited fd in a sibling,
// a shell pipeline's other stage). Then the binary is reparented to init /
// launchd and runs forever, holding its server port, its Chrome window and
// any persistent profile lock. Polling our parent pid catches that: once the
// original parent is gone, `process.ppid` changes to the reaper's pid.

export interface ParentWatchOptions {
  /** Called at most once, when the parent pid changes. */
  onParentGone: () => void;
  /** Parent-pid reader. Defaults to `process.ppid` (a live read). */
  getPpid?: () => number;
  /** Poll interval. Default 1000ms. */
  intervalMs?: number;
}

export function watchParent(opts: ParentWatchOptions): { stop: () => void } {
  const { onParentGone, getPpid = () => process.ppid, intervalMs = 1000 } = opts;
  const initial = getPpid();
  const timer = setInterval(() => {
    if (getPpid() !== initial) {
      clearInterval(timer);
      onParentGone();
    }
  }, intervalMs);
  // The mount's server keeps the loop alive; this watcher must not.
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}
