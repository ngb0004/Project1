/**
 * Graceful shutdown for the worker service.
 *
 * The first SIGTERM or SIGINT stops the loop from claiming new jobs (`stop`)
 * and gives the job in progress `graceMs` to finish; then `abort` fires, the
 * job's agent calls are cancelled and the worker releases the job back to the
 * queue. A second signal fires `abort` at once. Either way the process exits
 * after the worker has written the job's outcome, never in the middle of it.
 */

export interface Shutdown {
  /** Claim no new jobs. */
  readonly stop: AbortSignal;
  /** Stop the job in progress (the worker releases it). */
  readonly abort: AbortSignal;
  /** Records a signal (e.g. "SIGTERM"). */
  trigger(reason: string): void;
  /** Removes any process handlers and timers. */
  dispose(): void;
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(2))} s`;

export function createShutdown(graceMs: number, log: (message: string) => void = () => {}): Shutdown {
  const stop = new AbortController();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let count = 0;
  return {
    stop: stop.signal,
    abort: abort.signal,
    trigger(reason: string) {
      count++;
      if (count === 1) {
        stop.abort(new Error(`received ${reason}`));
        if (graceMs <= 0) {
          log(`${reason}: stopping; releasing the job in progress, if any`);
          abort.abort(new Error(`received ${reason}`));
          return;
        }
        log(`${reason}: claiming no new jobs; a job in progress gets ${seconds(graceMs)} to finish before it is released (send ${reason} again to release it now)`);
        timer = setTimeout(() => abort.abort(new Error(`received ${reason}; the ${seconds(graceMs)} shutdown grace ran out`)), graceMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      } else if (!abort.signal.aborted) {
        log(`${reason} again: releasing the job in progress now`);
        clearTimeout(timer);
        abort.abort(new Error(`received ${reason} twice`));
      }
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/** Wires SIGTERM and SIGINT to a shutdown; returns a function that unwires them. */
export function onShutdownSignals(shutdown: Shutdown, signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): () => void {
  const handlers = signals.map((sig) => {
    const h = () => shutdown.trigger(sig);
    process.on(sig, h);
    return [sig, h] as const;
  });
  return () => {
    for (const [sig, h] of handlers) process.off(sig, h);
    shutdown.dispose();
  };
}
