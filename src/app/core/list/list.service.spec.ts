import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { Viewer } from '../auth/anilist-viewer';
import type { AuthStatus } from '../auth/auth.service';
import { AuthService } from '../auth/auth.service';

import { CACHE_VERSION, ListStore, type CachedList } from './list-store';
import { LIST_TTL_MS, ListService } from './list.service';

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

const entry = (id: number, updatedAt: number) => ({
  id,
  status: 'CURRENT',
  progress: 1,
  repeat: 0,
  updatedAt,
  score: 0,
  media: { id, title: { romaji: 'x', english: null }, coverImage: null },
});

function listFetch(status: number, entries = [entry(1, 50), entry(2, 90)]) {
  const calls: string[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body));
    const body = { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries }] } } };
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const saved = (userId: number, fetchedAt: number): CachedList => ({
  version: CACHE_VERSION,
  userId,
  fetchedAt,
  watermark: 10,
  entries: [],
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

  it('shows a fresh saved copy without calling AniList', async () => {
    store.saved = saved(7, now - LIST_TTL_MS + 1);
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
    expect(list.entries()).toEqual([]);
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
