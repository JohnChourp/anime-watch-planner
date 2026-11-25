import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { App } from '@capacitor/app';

import { UnauthorizedError } from '../auth/anilist-viewer';
import { AuthService } from '../auth/auth.service';

import { fetchList, RateLimitedError, type ListEntry } from './anilist-list';
import { CACHE_VERSION, ListStore, type CachedList } from './list-store';

/** The "monthly" refresh: a saved list older than this is fetched again in full. */
export const LIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The user's AniList list, kept on the device. It loads the saved copy at once and fetches the whole list again
 * when there is none, when it is 30 days old, or when the user pulls to refresh. Sign-out deletes it.
 */
@Injectable({ providedIn: 'root' })
export class ListService {
  private readonly auth = inject(AuthService);
  private readonly store = inject(ListStore);
  private fetchFn: typeof fetch = (...args) => fetch(...args);
  private cache: CachedList | null = null;
  private loaded = false;
  private running: Promise<void> = Promise.resolve();
  /** Bumped on sign-out, so a refresh that finishes afterwards does not save the old user's list. */
  private generation = 0;

  readonly entries = signal<ListEntry[] | null>(null);
  /** When the list was last fetched in full (device time, ms), or null. */
  readonly fetchedAt = signal<number | null>(null);
  readonly refreshing = signal(false);
  /** A short, plain message when the list could not be fetched. */
  readonly message = signal<string | null>(null);
  /** Device time of the last start or resume, so "updated today" and the 30-day check follow the calendar. */
  readonly now = signal(Date.now());

  constructor() {
    effect(() => {
      const status = this.auth.status();
      const viewer = this.auth.viewer();
      untracked(() => {
        if (status === 'signedOut') {
          void this.clear();
        } else if (status === 'signedIn') {
          void this.sync(viewer?.id ?? null);
        }
      });
    });
    // An app kept in memory for weeks is resumed, not started: check the 30-day age again then.
    void App.addListener('resume', () => this.resume()).catch(() => undefined);
  }

  /** Back from the background: refresh the clock, and the list if it is now 30 days old. */
  resume(now = Date.now()): void {
    this.now.set(now);
    if (this.auth.status() === 'signedIn') {
      void this.sync(this.auth.viewer()?.id ?? null, now);
    }
  }

  /** For tests only. */
  useFetch(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  /** Pull-to-refresh: fetch the whole list now, whatever its age. */
  async refresh(now = Date.now()): Promise<void> {
    const generation = this.generation;
    await this.run(async () => {
      let viewer = this.auth.viewer();
      if (!viewer) {
        await this.auth.loadViewer();
        viewer = this.auth.viewer();
      }
      if (!viewer) {
        if (this.auth.accessToken(now) && generation === this.generation) {
          this.message.set('Could not reach AniList. Check your connection and try again.');
        }
        return;
      }
      await this.fetchAndSave(viewer.id, now, generation);
    });
  }

  /** Signed in: show the saved list at once, then fetch it again if it is missing, stale or someone else's. */
  async sync(viewerId: number | null, now = Date.now()): Promise<void> {
    const generation = this.generation;
    await this.run(async () => {
      if (generation !== this.generation) {
        return;
      }
      if (!this.loaded) {
        const saved = await this.store.read();
        if (generation !== this.generation) {
          return;
        }
        this.loaded = true;
        this.show(saved);
      }
      if (viewerId === null) {
        return; // Offline: keep showing the saved copy; the refresh waits until AniList answers.
      }
      if (this.cache && this.cache.userId !== viewerId) {
        this.show(null);
        await this.store.delete();
      }
      const age = this.cache ? now - this.cache.fetchedAt : Infinity;
      if (age >= LIST_TTL_MS || age < 0) {
        await this.fetchAndSave(viewerId, now, generation);
      }
    });
  }

  /** Sign-out: forget the list on this device. */
  async clear(): Promise<void> {
    this.generation++;
    this.loaded = false;
    this.show(null);
    this.message.set(null);
    // Queued, so a refresh that is saving right now cannot write the file back after it is deleted.
    await this.run(() => this.store.delete());
  }

  /** One job at a time; a second call waits for the first and then runs. */
  private async run(job: () => Promise<void>): Promise<void> {
    const next = this.running.then(job);
    this.running = next.catch(() => undefined);
    await next;
  }

  /** `generation` is taken when the job was asked for, so a sign-out in between cancels it. */
  private async fetchAndSave(userId: number, now: number, generation: number): Promise<void> {
    const token = this.auth.accessToken(now);
    if (!token || generation !== this.generation) {
      return;
    }
    this.refreshing.set(true);
    this.message.set(null);
    try {
      const entries = await fetchList(token, userId, this.fetchFn);
      if (generation !== this.generation) {
        return;
      }
      const list: CachedList = {
        version: CACHE_VERSION,
        userId,
        fetchedAt: now,
        watermark: entries.reduce((max, e) => Math.max(max, e.updatedAt), 0),
        entries,
      };
      this.loaded = true;
      this.show(list);
      await this.store.write(list).catch(() => {
        // Still shown; the next start fetches it again.
      });
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      if (error instanceof UnauthorizedError) {
        await this.auth.expire();
      } else if (error instanceof RateLimitedError) {
        this.message.set('AniList is busy right now. Try again in a minute.');
      } else {
        this.message.set(
          this.cache
            ? 'Could not update your list. Showing the saved copy.'
            : 'Could not load your list. Pull down to try again.',
        );
      }
    } finally {
      this.refreshing.set(false);
    }
  }

  private show(list: CachedList | null): void {
    this.cache = list;
    this.entries.set(list?.entries ?? null);
    this.fetchedAt.set(list?.fetchedAt ?? null);
  }
}
