import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { Viewer } from '../auth/anilist-viewer';
import type { AuthStatus } from '../auth/auth.service';
import { AuthService } from '../auth/auth.service';

import { CACHE_VERSION, ListStore, type CachedList } from './list-store';
import { CHANGES_INTERVAL_MS, LIST_TTL_MS, ListService } from './list.service';

class FakeAuth {
  status = signal<AuthStatus>('loading');
  viewer = signal<Viewer | null>(null);
  token: string | null = 'tok';
  expired = 0;
  viewerOnReload: Viewer | null = null;
  accessToken() {
    return this.token;
  }
  async expire() {
    this.expired++;
    this.token = null;
    this.status.set('signedOut');
  }
  async loadViewer() {
    this.viewer.set(this.viewerOnReload);
  }
}

class FakeStore {
  saved: CachedList | null = null;
  writes = 0;
  deletes = 0;
  async read() {
    return this.saved;
  }
  async write(list: CachedList) {
    this.writes++;
    this.saved = list;
  }
  async delete() {
    this.deletes++;
    this.saved = null;
  }
}

const entry = (id: number, updatedAt: number, mediaId = id) => ({
  id,
  status: 'CURRENT',
  progress: 1,
  repeat: 0,
  updatedAt,
  score: 0,
  media: { id: mediaId, title: { romaji: 'x', english: null }, coverImage: null },
});

/** Answers the full-list query with `entries`, and the changes query with `changes` (one page each). */
function listFetch(status: number, entries = [entry(1, 50), entry(2, 90)], changes: unknown[][] = [[]]) {
  const calls: string[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const sent = String(init.body);
    calls.push(sent.includes('UPDATED_TIME_DESC') ? 'changes' : 'full');
    const { variables } = JSON.parse(sent) as { variables: { page?: number } };
    const page = (variables.page ?? 1) - 1;
    const body = sent.includes('UPDATED_TIME_DESC')
      ? { data: { Page: { pageInfo: { hasNextPage: page + 1 < changes.length }, mediaList: changes[page] ?? [] } } }
      : { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries }] } } };
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const saved = (userId: number, fetchedAt: number, checkedAt = fetchedAt): CachedList => ({
  version: CACHE_VERSION,
  userId,
  fetchedAt,
  checkedAt,
  watermark: 50,
  entries: [entry(1, 50), entry(2, 40)] as never,
});

describe('ListService', () => {
  let auth: FakeAuth;
  let store: FakeStore;
  let list: ListService;
  const now = 5_000_000_000;
  const me = { id: 7, name: 'me' };

  beforeEach(() => {
    auth = new FakeAuth();
    store = new FakeStore();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: ListStore, useValue: store },
      ],
    });
    list = TestBed.inject(ListService);
  });

  it('fetches and saves the list when there is no saved copy', async () => {
    const { fn, calls } = listFetch(200);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(calls.length).toBe(1);
    expect(list.entries()?.map((e) => e.id)).toEqual([1, 2]);
    expect(list.fetchedAt()).toBe(now);
    expect(store.saved).toMatchObject({ version: CACHE_VERSION, userId: 7, fetchedAt: now, watermark: 90 });
  });

  it('shows a saved copy checked under 15 minutes ago without calling AniList', async () => {
    store.saved = saved(7, now - LIST_TTL_MS + 1, now - CHANGES_INTERVAL_MS + 1);
    const { fn, calls } = listFetch(200);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(calls.length).toBe(0);
    expect(list.fetchedAt()).toBe(now - LIST_TTL_MS + 1);
  });

  it('fetches again when the saved copy is 30 days old', async () => {
    store.saved = saved(7, now - LIST_TTL_MS);
    const { fn, calls } = listFetch(200);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(calls.length).toBe(1);
    expect(list.fetchedAt()).toBe(now);
  });

  it("throws away another user's saved list", async () => {
    store.saved = saved(99, now);
    const { fn, calls } = listFetch(200);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(store.deletes).toBe(1);
    expect(calls.length).toBe(1);
    expect(store.saved?.userId).toBe(7);
  });

  it('offline (no viewer yet): shows the saved copy and does not fetch', async () => {
    store.saved = saved(7, now - LIST_TTL_MS * 2);
    const { fn, calls } = listFetch(200);
    list.useFetch(fn);
    await list.sync(null, now);
    expect(calls.length).toBe(0);
    expect(list.entries()?.length).toBe(2);
  });

  it('pull-to-refresh fetches even a fresh list, asking AniList who is signed in when that was unknown', async () => {
    store.saved = saved(7, now);
    auth.viewerOnReload = me;
    const { fn, calls } = listFetch(200);
    list.useFetch(fn);
    await list.refresh(now + 1);
    expect(calls.length).toBe(1);
    expect(list.fetchedAt()).toBe(now + 1);
  });

  it('pull-to-refresh while AniList cannot be reached says so', async () => {
    await list.refresh(now);
    expect(list.message()).toBe('Could not reach AniList. Check your connection and try again.');
  });

  it('a 429 shows a message and keeps the saved copy, with no retry', async () => {
    store.saved = saved(7, now - LIST_TTL_MS);
    auth.viewer.set(me);
    const { fn, calls } = listFetch(429);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(calls.length).toBe(1);
    expect(list.message()).toBe('AniList is busy right now. Try again in a minute.');
    expect(list.fetchedAt()).toBe(now - LIST_TTL_MS);
  });

  it('a 401 ends the session', async () => {
    auth.viewer.set(me);
    list.useFetch(listFetch(401).fn);
    await list.sync(7, now);
    expect(auth.expired).toBe(1);
  });

  it('a server error with no saved copy asks the user to pull down', async () => {
    auth.viewer.set(me);
    list.useFetch(listFetch(500).fn);
    await list.sync(7, now);
    expect(list.message()).toBe('Could not load your list. Pull down to try again.');
    expect(list.entries()).toBeNull();
  });

  it('sign-out deletes the saved list, and a refresh still running does not save it back', async () => {
    auth.viewer.set(me);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (...args: Parameters<typeof fetch>) => {
      await gate;
      return listFetch(200).fn(...args);
    }) as typeof fetch;
    list.useFetch(slow);
    const running = list.sync(7, now);
    const cleared = list.clear();
    release();
    await Promise.all([running, cleared]);
    expect(store.saved).toBeNull();
    expect(list.entries()).toBeNull();
  });

  it('on resume, fetches a list that has turned 30 days old while the app was in memory', async () => {
    const now = Date.now(); // The status effect syncs with the real clock.
    store.saved = saved(7, now);
    auth.viewer.set(me);
    auth.status.set('signedIn');
    const { fn, calls } = listFetch(200);
    list.useFetch(fn);
    TestBed.tick();
    await vi.waitFor(() => expect(list.entries()?.length).toBe(2));
    expect(calls.length).toBe(0);
    list.resume(now + LIST_TTL_MS);
    await vi.waitFor(() => expect(calls).toEqual(['full']));
    expect(list.now()).toBe(now + LIST_TTL_MS);
  });

  it('a pull-to-refresh before the first load is not undone by the next sync', async () => {
    auth.viewer.set(me);
    store.write = async () => {
      throw new Error('disk full');
    };
    const { fn, calls } = listFetch(200);
    list.useFetch(fn);
    await list.refresh(now);
    await list.sync(7, now);
    expect(calls.length).toBe(1);
    expect(list.entries()?.length).toBe(2);
  });

  it('checks a fresh list for changes 15 minutes after the last check, and merges them', async () => {
    store.saved = saved(7, now - 1000, now - CHANGES_INTERVAL_MS);
    const changed = { ...entry(2, 60), progress: 5 };
    const added = entry(3, 50);
    const { fn, calls } = listFetch(200, [], [[changed, added, entry(1, 50), entry(9, 49)]]);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(calls).toEqual(['changes']);
    expect(list.entries()?.map((e) => [e.id, e.progress])).toEqual([
      [1, 1],
      [2, 5],
      [3, 1],
    ]);
    expect(store.saved).toMatchObject({ fetchedAt: now - 1000, checkedAt: now, watermark: 60 });
    expect(list.checkedAt()).toBe(now);
    await list.sync(7, now + 1000);
    expect(calls.length).toBe(1);
  });

  it('with no changes, moves only the check time', async () => {
    store.saved = saved(7, now - 1000, now - CHANGES_INTERVAL_MS);
    const { fn, calls } = listFetch(200, [], [[entry(1, 49)]]);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(calls).toEqual(['changes']);
    expect(store.saved).toMatchObject({ checkedAt: now, watermark: 50 });
    expect(store.saved?.entries.length).toBe(2);
  });

  it('fetches the whole list when there are more than 10 pages of changes', async () => {
    store.saved = saved(7, now - 1000, now - CHANGES_INTERVAL_MS);
    const pages = Array.from({ length: 11 }, (_, i) => [entry(100 + i, 60)]);
    const { fn, calls } = listFetch(200, [entry(1, 70)], pages);
    list.useFetch(fn);
    vi.useFakeTimers();
    try {
      const done = list.sync(7, now);
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(calls.filter((c) => c === 'changes').length).toBe(10);
    expect(calls.at(-1)).toBe('full');
    expect(store.saved).toMatchObject({ fetchedAt: now, checkedAt: now, watermark: 70 });
  });

  it('an anime removed and added again on the site replaces its old entry', async () => {
    store.saved = saved(7, now - 1000, now - CHANGES_INTERVAL_MS);
    const { fn } = listFetch(200, [], [[entry(30, 60, 2)]]);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(list.entries()?.map((e) => [e.id, e.media.id])).toEqual([
      [1, 1],
      [30, 2],
    ]);
  });

  it('a failed check stays quiet, keeps the saved copy and tries again on the next start', async () => {
    store.saved = saved(7, now - 1000, now - CHANGES_INTERVAL_MS);
    for (const status of [500, 429]) {
      const { fn, calls } = listFetch(status);
      list.useFetch(fn);
      await list.sync(7, now);
      expect(calls).toEqual(['changes']);
      expect(list.message()).toBeNull();
      expect(list.entries()?.length).toBe(2);
      expect(list.checkedAt()).toBe(now - CHANGES_INTERVAL_MS);
    }
    expect(store.writes).toBe(0);
  });

  it('a 401 during a check ends the session', async () => {
    store.saved = saved(7, now - 1000, now - CHANGES_INTERVAL_MS);
    list.useFetch(listFetch(401).fn);
    await list.sync(7, now);
    expect(auth.expired).toBe(1);
  });

  it('sign-out during a check does not save the old list back', async () => {
    store.saved = saved(7, now - 1000, now - CHANGES_INTERVAL_MS);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (...args: Parameters<typeof fetch>) => {
      await gate;
      return listFetch(200, [], [[entry(3, 60)]]).fn(...args);
    }) as typeof fetch;
    list.useFetch(slow);
    const running = list.sync(7, now);
    await vi.waitFor(() => expect(list.refreshing()).toBe(true));
    const cleared = list.clear();
    release();
    await Promise.all([running, cleared]);
    expect(store.saved).toBeNull();
    expect(list.entries()).toBeNull();
  });

  it('reacts to the sign-in status: signed in loads, signed out clears', async () => {
    const { fn } = listFetch(200);
    list.useFetch(fn);
    auth.viewer.set(me);
    auth.status.set('signedIn');
    TestBed.tick();
    await vi.waitFor(() => expect(list.entries()?.length).toBe(2));
    auth.status.set('signedOut');
    TestBed.tick();
    await vi.waitFor(() => expect(store.deletes).toBeGreaterThan(0));
    expect(list.entries()).toBeNull();
  });
});
