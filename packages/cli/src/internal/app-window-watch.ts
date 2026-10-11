// Detect "the app-mode window is gone but Chrome is still running" (ui-leaf#101).
//
// On macOS, closing the last window of a Chrome instance (red button / ⌘W)
// leaves the browser process running with zero windows. For a shell:"app"
// mount that is a dead end: the child never exits, so nothing tells the mount
// to close, and a persistent profile stays locked. This watcher polls the
// number of `page` targets and fires `onEmpty` once there have been none for
// `emptyGraceMs` (after having seen at least one), or for `launchGraceMs`
// after launch if a page never appeared.
//
// Why page targets and not the heartbeat: a minimized or occluded window
// pauses its heartbeat but keeps its page target, so this signal never fires
// for a window the user is deliberately hiding (the minimize-safety invariant
// on trackedAppWindows in server.ts). It also covers windows that navigated
// away from the ui-leaf page (CDP-driven hosts), which have no heartbeat.
//
// A failed probe (`countPages` resolves null) is "unknown" and never counts
// toward the empty clock; a browser that actually died is caught by the
// child's exit event instead.

export interface AppWindowWatchOptions {
  /** Current number of page targets, or null when the probe failed. */
  countPages: () => Promise<number | null>;
  /** Called at most once, when the window set is judged empty. */
  onEmpty: () => void;
  /** Poll interval. Default 1000ms. */
  intervalMs?: number;
  /** How long zero pages must persist (after one was seen). Default 3000ms. */
  emptyGraceMs?: number;
  /** How long to wait for a first page after launch. Default 15000ms. */
  launchGraceMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export const DEFAULT_APP_WATCH_INTERVAL_MS = 1000;
export const DEFAULT_APP_EMPTY_GRACE_MS = 3000;
export const DEFAULT_APP_LAUNCH_GRACE_MS = 15_000;

export function watchAppWindows(opts: AppWindowWatchOptions): { stop: () => void } {
  const {
    countPages,
    onEmpty,
    intervalMs = DEFAULT_APP_WATCH_INTERVAL_MS,
    emptyGraceMs = DEFAULT_APP_EMPTY_GRACE_MS,
    launchGraceMs = DEFAULT_APP_LAUNCH_GRACE_MS,
    now = Date.now,
  } = opts;

  let stopped = false;
  let inFlight = false;
  let seenPage = false;
  // Start of the current zero-page stretch (or launch time before any page).
  let emptySince = now();

  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    let count: number | null;
    try {
      count = await countPages();
    } finally {
      inFlight = false;
    }
    if (stopped || count === null) return;
    const t = now();
    if (count > 0) {
      seenPage = true;
      emptySince = t;
      return;
    }
    if (t - emptySince >= (seenPage ? emptyGraceMs : launchGraceMs)) {
      stop();
      onEmpty();
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Never keep the host's event loop alive on our account.
  (timer as { unref?: () => void }).unref?.();

  return { stop };
}
