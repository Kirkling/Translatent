// Background-safe timers + screen wake lock.
//
// Browsers clamp setTimeout in hidden tabs (>=1s, and on mobile they can be
// frozen entirely). A dedicated Worker keeps its own timer loop alive, which
// survives backgrounding far better, so long translation runs continue when the
// user switches tabs or apps.

let worker: Worker | null = null;
let seq = 0;
const waiters = new Map<number, () => void>();

const WORKER_SRC = `
self.onmessage = (e) => {
  const { id, ms } = e.data || {};
  setTimeout(() => self.postMessage({ id }), ms);
};
`;

function getWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    worker = new Worker(url);
    worker.onmessage = (e: MessageEvent) => {
      const id = (e.data as { id?: number })?.id;
      if (id == null) return;
      const done = waiters.get(id);
      if (done) { waiters.delete(id); done(); }
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Sleep that keeps ticking while the tab is hidden. */
export function bgSleep(ms: number): Promise<void> {
  const w = getWorker();
  if (!w) return new Promise((r) => setTimeout(r, ms));
  const id = ++seq;
  return new Promise<void>((resolve) => {
    waiters.set(id, resolve);
    w.postMessage({ id, ms });
    // Safety net in case the worker is killed by the browser.
    setTimeout(() => {
      if (waiters.delete(id)) resolve();
    }, ms + 5000);
  });
}

type WakeLockSentinelLike = { release: () => Promise<void> };
let sentinel: WakeLockSentinelLike | null = null;

/** Best-effort screen wake lock so mobile doesn't freeze the page mid-run. */
export async function acquireWakeLock(): Promise<void> {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinelLike> };
    };
    if (!nav.wakeLock || sentinel) return;
    sentinel = await nav.wakeLock.request("screen");
  } catch {
    sentinel = null;
  }
}

export async function releaseWakeLock(): Promise<void> {
  try { await sentinel?.release(); } catch {/* noop */}
  sentinel = null;
}
