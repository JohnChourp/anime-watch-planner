import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { App } from '@capacitor/app';

import { UnauthorizedError } from '../auth/anilist-viewer';
import { AuthService } from '../auth/auth.service';

import { fetchChanges, fetchList, RateLimitedError, saveStatus, type ListEntry, type ListStatus } from './anilist-list';
import { CACHE_VERSION, ListStore, type CachedList } from './list-store';

/** The "monthly" refresh: a saved list older than this is fetched again in full. */
export const LIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A fresh list is checked for changes on start or resume, at most this often. */
export const CHANGES_INTERVAL_MS = 15 * 60 * 1000;

interface StatusEdit {
  pending: ListStatus | null;
  message: string;
}

/**
 * The user's AniList list, kept on the device. It loads the saved copy at once and fetches the whole list again
 * when there is none, when it is 30 days old, or when the user pulls to refresh. Otherwise, on start or resume and
 * at most every 15 minutes, it asks AniList only for the entries changed since. Sign-out deletes it.
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
  /** When the list was last fetched in full (device time, ms), or null: the 30-day clock, not "updated …". */
  readonly fetchedAt = signal<number | null>(null);
  /** When the list was last fetched in full or checked for changes (device time, ms), or null. */
  readonly checkedAt = signal<number | null>(null);
  readonly refreshing = signal(false);
  readonly statusEdits = signal<ReadonlyMap<number, StatusEdit>>(new Map());
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

  /** Back from the background: refresh the clock, then check the list (30 days old, or 15 minutes since a check). */
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
      await this.fetchAndSave(viewer.id, now, generation, true);
    });
  }

  /** Taps on one title coalesce. Confirmed writes and refreshes use the same serial queue. */
  async changeStatus(id: number, status: ListStatus): Promise<void> {
    const userId = this.auth.viewer()?.id;
    const token = this.auth.accessToken();
    const entry = this.cache?.entries.find((item) => item.id === id);
    if (!entry || !userId || !token || this.cache?.userId !== userId || this.auth.status() !== 'signedIn') {
      return;
    }
    const previous = this.statusEdits().get(id);
    if (status === (previous?.pending ?? entry.status)) {
      return;
    }
    const generation = this.generation;
    const sameSession = () =>
      this.generation === generation &&
      this.auth.status() === 'signedIn' &&
      this.auth.viewer()?.id === userId &&
      this.auth.accessToken() === token;
    let edit: StatusEdit = { pending: status, message: 'Saving to AniList…' };
    const current = () => this.statusEdits().get(id) === edit;
    this.setStatusEdit(id, edit);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.run(async () => {
      if (!current()) return;
      if (!sameSession()) {
        this.setStatusEdit(id, null);
        return;
      }
      const cache = this.cache;
      const existing = cache?.entries.find((item) => item.id === id);
      if (!cache || cache.userId !== userId || existing?.media.id !== entry.media.id) {
        this.setStatusEdit(id, { pending: null, message: 'This title is no longer in your list. Refresh your list.' });
        return;
      }
      // The shared gate may wait before dispatch. A newer tap or a sign-out cancels a still-unsent write.
      const send: typeof fetch = (url, init) => {
        if (!current() || !sameSession()) throw new Error('Status change cancelled.');
        return this.fetchFn(url, init);
      };
      try {
        const confirmed = await saveStatus(token, id, status, send, {
          onWait: (seconds) => {
            if (current() && sameSession()) {
              edit = { pending: status, message: `AniList is busy. Waiting ${seconds} s…` };
              this.setStatusEdit(id, edit);
            }
          },
        });
        if (!sameSession()) return;
        if (confirmed.media.id !== existing.media.id) throw new Error('AniList returned a different title.');
        // Only this entry was checked. Advancing the list watermark could skip other titles changed on AniList.
        const stored = await this.save({
          ...cache,
          entries: cache.entries.map((item) => (item.id === id ? confirmed : item)),
        });
        if (current()) {
          this.setStatusEdit(id, {
            pending: null,
            message: stored ? 'Saved to AniList.' : 'Saved to AniList. This device could not store the change.',
          });
        }
      } catch (error) {
        if (!sameSession()) return;
        if (error instanceof UnauthorizedError) {
          await this.auth.expire();
        } else if (current()) {
          const message =
            error instanceof RateLimitedError
              ? 'AniList is busy. Try again in a minute.'
              : 'Could not confirm the change. Refresh your list and try again.';
          this.setStatusEdit(id, { pending: null, message });
        }
      } finally {
        // A viewer can change while a request waits, before the sign-out effect clears the list.
        if (current()) this.setStatusEdit(id, null);
      }
    });
  }

  private setStatusEdit(id: number, edit: StatusEdit | null): void {
    this.statusEdits.update((edits) => {
      const next = new Map(edits);
      if (edit) next.set(id, edit);
      else next.delete(id);
      return next;
    });
  }

  /**
   * Signed in: show the saved list at once, then fetch it again if it is missing, 30 days old or someone else's,
   * or else check it for changes if the last check was 15 minutes ago or more.
   */
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
        return;
      }
      const sinceCheck = now - (this.cache?.checkedAt ?? 0);
      if (sinceCheck >= CHANGES_INTERVAL_MS || sinceCheck < 0) {
        await this.checkChanges(viewerId, now, generation);
      }
    });
  }

  /** Sign-out: forget the list on this device. */
  async clear(): Promise<void> {
    this.generation++;
    this.statusEdits.set(new Map());
    this.loaded = false;
    this.show(null);
    this.message.set(null);
    // Queued, so a refresh that is saving right now cannot write the file back after it is deleted. A refresh
    // waiting for AniList's limit delays the delete by up to 60 s; the list is off the screen at once.
    await this.run(() => this.store.delete());
  }

  /** One job at a time; a second call waits for the first and then runs. */
  private async run(job: () => Promise<void>): Promise<void> {
    const next = this.running.then(job);
    this.running = next.catch(() => undefined);
    await next;
  }

  /**
   * `generation` is taken when the job was asked for, so a sign-out in between cancels it.
   * `userAsked` (pull-to-refresh): say how long AniList asks to wait, and on 429 try once more.
   */
  private async fetchAndSave(userId: number, now: number, generation: number, userAsked = false): Promise<void> {
    const token = this.auth.accessToken(now);
    if (!token || generation !== this.generation) {
      return;
    }
    this.refreshing.set(true);
    this.message.set(null);
    try {
      // Only what the user asked for says it is waiting; a refresh on start or resume stays quiet.
      const onWait = (seconds: number) => {
        if (generation === this.generation) {
          this.message.set(`AniList is busy. Waiting ${seconds} s…`);
        }
      };
      const options = userAsked ? { retry: true, onWait } : {};
      const entries = await fetchList(token, userId, this.fetchFn, undefined, options);
      if (generation !== this.generation) {
        return;
      }
      const list: CachedList = {
        version: CACHE_VERSION,
        userId,
        fetchedAt: now,
        checkedAt: now,
        watermark: highest(entries, 0),
        entries,
      };
      this.loaded = true;
      this.message.set(null);
      this.statusEdits.update((edits) => new Map([...edits].filter(([, edit]) => edit.pending !== null)));
      await this.save(list);
    } catch (error) {
      await this.fail(error, generation);
    } finally {
      this.refreshing.set(false);
    }
  }

  /**
   * Asks AniList only for the entries changed since the last one seen, and puts them into the saved list.
   * The user did not ask for it, so a failure stays quiet (the next start or resume tries again); 401 still signs out.
   */
  private async checkChanges(userId: number, now: number, generation: number): Promise<void> {
    const cache = this.cache;
    const token = this.auth.accessToken(now);
    if (!cache || !token || generation !== this.generation) {
      return;
    }
    this.refreshing.set(true);
    try {
      const changed = await fetchChanges(token, userId, cache.watermark, this.fetchFn);
      if (generation !== this.generation || this.cache !== cache) {
        return; // Signed out meanwhile.
      }
      if (changed !== null) {
        // By media: an anime removed and added again on the site comes back as a new entry id.
        const byMedia = new Map(cache.entries.map((e) => [e.media.id, e]));
        for (const entry of changed) {
          byMedia.set(entry.media.id, entry);
        }
        const watermark = highest(changed, cache.watermark);
        this.message.set(null);
        await this.save({ ...cache, checkedAt: now, watermark, entries: [...byMedia.values()] });
        return;
      }
    } catch (error) {
      if (error instanceof UnauthorizedError && generation === this.generation) {
        await this.auth.expire();
      }
      return;
    } finally {
      this.refreshing.set(false);
    }
    // More than 10 pages of changes: the whole list is cheaper.
    await this.fetchAndSave(userId, now, generation);
  }

  private async save(list: CachedList): Promise<boolean> {
    this.show(list);
    try {
      await this.store.write(list);
      return true;
    } catch {
      return false; // Still available in memory.
    }
  }

  private async fail(error: unknown, generation: number): Promise<void> {
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
  }

  private show(list: CachedList | null): void {
    this.cache = list;
    this.entries.set(list?.entries ?? null);
    this.fetchedAt.set(list?.fetchedAt ?? null);
    this.checkedAt.set(list?.checkedAt ?? null);
  }
}

/** The newest AniList `updatedAt` among the entries, or `floor` if none is newer. */
function highest(entries: ListEntry[], floor: number): number {
  return entries.reduce((max, e) => Math.max(max, e.updatedAt), floor);
}
