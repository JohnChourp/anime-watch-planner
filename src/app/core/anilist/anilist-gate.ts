/** Waiting longer than this is never needed: AniList's limit is per minute. */
const MAX_WAIT_MS = 60_000;
/** When this many calls are left in the minute, the next call waits for the limit to reset. */
const RESERVE = 2;

export interface GateOptions {
  /** On 429, wait and try once more (only for what the user asked for, such as pull-to-refresh). */
  retry?: boolean;
  /** Called with the wait in whole seconds before a retry, so the screen can say so. */
  onWait?: (seconds: number) => void;
}

/**
 * Every AniList call goes through here (task 3.3, decided 2026-11-25): one call at a time, a wait for the reset when
 * the minute's calls are almost used up, and on 429 at most one more try after the wait.
 * The WebView can read X-RateLimit-Remaining and X-RateLimit-Reset (seconds since 1970), but not Retry-After,
 * which AniList does not expose to browsers; without a reset time the wait is 60 s.
 */
export class AniListGate {
  private queue: Promise<unknown> = Promise.resolve();
  /** Device time (ms) before which no call is sent. */
  private blockedUntil = 0;

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** For tests only: forget any wait. */
  reset(): void {
    this.queue = Promise.resolve();
    this.blockedUntil = 0;
  }

  send(fetchFn: typeof fetch, url: string, init: RequestInit, options: GateOptions = {}): Promise<Response> {
    const next = this.queue.then(() => this.sendNow(fetchFn, url, init, options));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async sendNow(
    fetchFn: typeof fetch,
    url: string,
    init: RequestInit,
    options: GateOptions,
  ): Promise<Response> {
    await this.waitIfBlocked();
    let response = await fetchFn(url, init);
    this.note(response);
    if (response.status === 429 && options.retry) {
      options.onWait?.(Math.ceil(Math.max(0, this.blockedUntil - this.clock()) / 1000));
      await this.waitIfBlocked();
      response = await fetchFn(url, init);
      this.note(response);
    }
    return response;
  }

  private async waitIfBlocked(): Promise<void> {
    const wait = this.blockedUntil - this.clock();
    if (wait > 0) {
      await this.sleep(Math.min(wait, MAX_WAIT_MS));
    }
  }

  /** Blocks the next calls until the reset when AniList answered 429 or the minute's calls are almost used up. */
  private note(response: Response): void {
    const remaining = Number(response.headers.get('X-RateLimit-Remaining') ?? NaN);
    if (response.status !== 429 && !(Number.isFinite(remaining) && remaining <= RESERVE)) {
      return;
    }
    const reset = Number(response.headers.get('X-RateLimit-Reset') ?? NaN) * 1000;
    const now = this.clock();
    // The device clock may differ from AniList's: keep the wait between 1 s and 60 s.
    const wait = Number.isFinite(reset) && reset > 0 ? Math.min(Math.max(reset - now, 1000), MAX_WAIT_MS) : MAX_WAIT_MS;
    this.blockedUntil = Math.max(this.blockedUntil, now + wait);
  }
}

/** The one gate the app uses. */
export const anilistGate = new AniListGate();
