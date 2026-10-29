/** App lifetime scheduler: one in-flight request, fast active jobs, slow idle work.
 * Explicit local/remote actions wake the observer immediately. */
export function createUpdatePolling(refresh: () => Promise<void>, active: () => boolean, timer: {
  set(fn: () => void, delay: number): unknown; clear(id: unknown): void;
}) {
  let stopped = false, running = false, wakePending = false, pending: unknown;
  const schedule = (delay: number) => { timer.clear(pending); pending = timer.set(() => { void run(); }, delay); };
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try { await refresh(); } finally {
      running = false;
      if (!stopped) schedule(wakePending ? 0 : active() ? 1000 : 15000);
      wakePending = false;
    }
  };
  void run();
  const stop = () => { stopped = true; timer.clear(pending); };
  stop.wake = () => { if (stopped) return; if (running) wakePending = true; else schedule(0); };
  return stop;
}
