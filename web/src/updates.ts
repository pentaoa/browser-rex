// Only the visible workspace watches for changes. Aborting the lifecycle also
// releases a pending long poll or backoff when the user switches hosts.
export class WorkspaceUpdates {
  private controller?: AbortController;

  constructor(
    private refresh: () => Promise<boolean | void>,
    private readVersion: (since: string, signal: AbortSignal) => Promise<string>,
  ) {}

  stop() {
    this.controller?.abort();
    this.controller = undefined;
  }

  start() {
    this.stop();
    if (document.hidden) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.watch(controller.signal);
  }

  private async watch(signal: AbortSignal) {
    let version = "";
    let failures = 0;
    while (!signal.aborted) {
      try {
        const next = await this.readVersion(version, signal);
        if (signal.aborted) return;
        if (next !== version) {
          if (await this.refresh() === false) {
            // Keep the last applied cursor so a failed view is read again.
            await this.backoff(failures++, signal);
            continue;
          }
          version = next;
        }
        failures = 0;
      } catch {
        if (signal.aborted) return;
        // A temporary stream error can still permit a direct view read.
        // Only reads are retried, never actions or terminal input.
        version = "";
        await this.refresh();
        await this.backoff(failures++, signal);
      }
    }
  }

  private backoff(failures: number, signal: AbortSignal) {
    if (signal.aborted) return;
    return new Promise<void>(resolve => {
      const done = () => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = window.setTimeout(done, Math.min(30_000, 1500 * 2 ** Math.min(failures, 5)));
      signal.addEventListener("abort", done, {once: true});
    });
  }
}
