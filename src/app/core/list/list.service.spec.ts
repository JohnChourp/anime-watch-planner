import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { anilistGate } from '../anilist/anilist-gate';
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

  it('pull-to-refresh on 429 says how long AniList asks to wait, then tries once more', async () => {
    auth.viewer.set(me);
    let calls = 0;
    const seen: (string | null)[] = [];
    const fn = (async () => {
      calls++;
      seen.push(list.message());
      if (calls === 1) {
        const reset = String(Math.ceil(Date.now() / 1000) + 1);
        return new Response('{}', {
          status: 429,
          headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': reset },
        });
      }
      const body = { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries: [entry(1, 50)] }] } } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    list.useFetch(fn);
    await list.refresh(now);
    expect(calls).toBe(2);
    expect(seen[1]).toMatch(/^AniList is busy\. Waiting [12] s…$/);
    expect(list.message()).toBeNull();
    expect(list.entries()?.length).toBe(1);
  });

  it('a refresh on start waiting behind a 429 stays quiet', async () => {
    store.saved = saved(7, now - LIST_TTL_MS);
    const reset = String(Math.ceil(Date.now() / 1000) + 1);
    const seen: (string | null)[] = [];
    const fn = (async () => {
      seen.push(list.message());
      if (seen.length === 1) {
        return new Response('{}', { status: 429, headers: { 'X-RateLimit-Reset': reset } });
      }
      const body = { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries: [] }] } } };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    list.useFetch(fn);
    await list.sync(7, now); // 429: the gate now waits about 1 s before the next call.
    await list.sync(7, now);
    expect(seen).toEqual([null, null]);
  });

  it('the 30-day refresh on 429 does not try again', async () => {
    store.saved = saved(7, now - LIST_TTL_MS);
    const { fn, calls } = listFetch(429);
    list.useFetch(fn);
    await list.sync(7, now);
    expect(calls.length).toBe(1);
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

  describe('changing the status of an existing entry', () => {
    beforeEach(async () => {
      store.saved = saved(me.id, Date.now());
      auth.viewer.set(me);
      auth.status.set('signedIn');
      TestBed.tick();
      await list.sync(me.id);
    });

    it('sends the last rapid choice per title, merges each confirmation, and keeps the list watermark', async () => {
      const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const { id, status } = JSON.parse(String(init?.body)).variables;
        return Response.json({ data: { SaveMediaListEntry: { ...entry(id, 105), status, progress: 7 } } });
      });
      list.useFetch(send);
      const initial = store.saved!;
      await Promise.all([
        list.changeStatus(1, 'PLANNING'),
        list.changeStatus(1, 'PAUSED'),
        list.changeStatus(2, 'REPEATING'),
      ]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(store.saved?.entries.map((e) => [e.status, e.progress])).toEqual([
        ['PAUSED', 7],
        ['REPEATING', 7],
      ]);
      expect(store.saved).toMatchObject({
        watermark: initial.watermark,
        checkedAt: initial.checkedAt,
        fetchedAt: initial.fetchedAt,
      });
      expect(list.statusEdits().get(1)?.message).toBe('Saved to AniList.');
    });

    it('cancels a quick return to the saved status without sending any mutation', async () => {
      const send = vi.fn(listFetch(500).fn);
      list.useFetch(send);
      const first = list.changeStatus(1, 'PAUSED');
      await list.changeStatus(1, 'CURRENT');
      await first;
      expect(send).not.toHaveBeenCalled();
      expect(list.statusEdits().has(1)).toBe(false);
      expect(store.writes).toBe(0);
    });

    it.each([true, false])(
      'only dispatches an edit still wanted after the rate limit resets (cancel: %s)',
      async (cancel) => {
        vi.useFakeTimers();
        try {
          await anilistGate.send(
            async () => new Response(null, { status: 429, headers: { 'Retry-After': '1' } }),
            '/',
            {},
          );
          const send = vi.fn(async () =>
            Response.json({ data: { SaveMediaListEntry: { ...entry(1, 65), status: 'PAUSED' } } }),
          );
          list.useFetch(send);
          const first = list.changeStatus(1, 'PAUSED');
          await vi.advanceTimersByTimeAsync(250);
          expect(list.statusEdits().get(1)?.message).toContain('Waiting');
          await vi.advanceTimersByTimeAsync(749);
          expect(send).not.toHaveBeenCalled();
          if (cancel) await list.changeStatus(1, 'CURRENT');
          await vi.advanceTimersByTimeAsync(1);
          await first;
          expect(send).toHaveBeenCalledTimes(cancel ? 0 : 1);
          expect(store.saved?.entries[0].status).toBe(cancel ? 'CURRENT' : 'PAUSED');
          if (cancel) expect(list.statusEdits().has(1)).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each(['confirmed', 'confirmed after undo', 'lost'])(
      'sends the undo when the first request was dispatched and its reply is %s',
      async (outcome) => {
        let reply!: (response: Response) => void;
        const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
          const { status } = JSON.parse(String(init?.body)).variables;
          if (status === 'PAUSED') return new Promise<Response>((resolve) => (reply = resolve));
          return Response.json({ data: { SaveMediaListEntry: { ...entry(1, 62), status } } });
        });
        list.useFetch(send);
        const first = list.changeStatus(1, 'PAUSED');
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        const intermediate = list.changeStatus(1, 'DROPPED');
        const earlyUndo = outcome === 'confirmed after undo' ? list.changeStatus(1, 'CURRENT') : undefined;
        reply(
          outcome !== 'lost'
            ? Response.json({ data: { SaveMediaListEntry: { ...entry(1, 61), status: 'PAUSED' } } })
            : Response.json({}, { status: 503 }),
        );
        await first;
        await Promise.all([intermediate, earlyUndo ?? list.changeStatus(1, 'CURRENT')]);
        expect(send.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).variables.status)).toEqual([
          'PAUSED',
          'CURRENT',
        ]);
        expect(store.saved?.entries[0].status).toBe('CURRENT');
        expect(list.statusEdits().get(1)?.message).toBe('Saved to AniList.');
      },
    );

    it('clears a pending selection on failure, retains the confirmed row and lets the user retry', async () => {
      const original = store.saved;
      list.useFetch(async () => Response.json({}, { status: 500 }));
      await list.changeStatus(1, 'PAUSED');
      expect(store.saved).toBe(original);
      expect(list.statusEdits().get(1)).toMatchObject({
        pending: null,
        message: expect.stringContaining('Could not confirm'),
      });
      list.useFetch(async () => Response.json({ data: { SaveMediaListEntry: { ...entry(1, 62), status: 'PAUSED' } } }));
      await list.changeStatus(1, 'PAUSED');
      expect(store.saved?.entries[0].status).toBe('PAUSED');
      expect(store.saved?.entries[1]).toBe(original?.entries[1]);
    });

    it('never sends a queued change for a different account, a missing entry or a signed-out session', async () => {
      const send = vi.fn(listFetch(200, [entry(90, 60)]).fn);
      list.useFetch(send);
      await list.changeStatus(99, 'PAUSED');
      const pending = list.changeStatus(1, 'PAUSED');
      auth.viewer.set({ id: 9, name: 'other' });
      await pending;
      await list.changeStatus(1, 'PAUSED');
      auth.viewer.set(me);
      const last = list.changeStatus(1, 'DROPPED');
      await list.clear();
      await last;
      expect(send.mock.calls.filter(([, init]) => String(init?.body).includes('SaveMediaListEntry'))).toHaveLength(0);
      expect(list.statusEdits().size).toBe(0);
    });

    it('does not restore a signed-out list when an in-flight write answers', async () => {
      let release!: (response: Response) => void;
      const send = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
      list.useFetch(send);
      const pending = list.changeStatus(1, 'PAUSED');
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const clear = list.clear();
      release(Response.json({ data: { SaveMediaListEntry: { ...entry(1, 60), status: 'PAUSED' } } }));
      await Promise.all([clear, pending]);
      expect(list.entries()).toBeNull();
      expect(store.saved).toBeNull();
      expect(list.statusEdits().size).toBe(0);
    });

    it('reports a 429 without replaying the write, and a 401 asks for sign-in again', async () => {
      const limited = vi.fn(async () => Response.json({}, { status: 429, headers: { 'Retry-After': '1' } }));
      list.useFetch(limited);
      await list.changeStatus(1, 'PAUSED');
      expect(limited).toHaveBeenCalledTimes(1);
      expect(list.statusEdits().get(1)?.message).toContain('busy');
      list.useFetch(async () => Response.json({}, { status: 401 }));
      await list.changeStatus(1, 'PAUSED');
      expect(auth.expired).toBe(1);
    });

    it('distinguishes a confirmed remote change from a failed device save', async () => {
      store.write = async () => {
        throw new Error('disk full');
      };
      list.useFetch(async () => Response.json({ data: { SaveMediaListEntry: { ...entry(1, 65), status: 'PAUSED' } } }));
      await list.changeStatus(1, 'PAUSED');
      expect(list.entries()?.[0].status).toBe('PAUSED');
      expect(store.saved?.entries[0].status).toBe('CURRENT');
      expect(list.unsavedMediaIds().has(1)).toBe(true);
      expect(list.statusEdits().get(1)).toMatchObject({ pending: null, message: 'Saved to AniList.' });
    });

    it.each([true, false])(
      'keeps the result of the one dispatched request on a matching last tap (disk works: %s)',
      async (stored) => {
        let reply!: (response: Response) => void;
        const send = vi.fn(() => new Promise<Response>((resolve) => (reply = resolve)));
        list.useFetch(send);
        if (!stored) vi.spyOn(store, 'write').mockRejectedValue(new Error('disk full'));
        const first = list.changeStatus(1, 'PAUSED');
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        const middle = list.changeStatus(1, 'DROPPED');
        const last = list.changeStatus(1, 'PAUSED');
        reply(Response.json({ data: { SaveMediaListEntry: { ...entry(1, 65), status: 'PAUSED' } } }));
        await Promise.all([first, middle, last]);
        expect(send).toHaveBeenCalledTimes(1);
        expect(list.entries()?.[0].status).toBe('PAUSED');
        expect(store.saved?.entries[0].status).toBe(stored ? 'PAUSED' : 'CURRENT');
        expect(list.unsavedMediaIds().has(1)).toBe(!stored);
        expect(list.statusEdits().get(1)?.message).toBe('Saved to AniList.');
      },
    );

    it.each(['CURRENT', 'PAUSED'])('honours the last tap after a queued refresh returns %s', async (remoteStatus) => {
      let reply!: (response: Response) => void;
      const writes: string[] = [];
      let remote = 'CURRENT';
      const reads = listFetch(200, [{ ...entry(1, 75), status: remoteStatus }]);
      list.useFetch(async (url, init) => {
        const { query, variables } = JSON.parse(String(init?.body));
        if (!query.includes('SaveMediaListEntry')) {
          remote = remoteStatus;
          return reads.fn(url, init);
        }
        writes.push(variables.status);
        remote = variables.status;
        if (writes.length === 1) return new Promise<Response>((resolve) => (reply = resolve));
        return Response.json({ data: { SaveMediaListEntry: { ...entry(1, 80), status: remote } } });
      });
      const first = list.changeStatus(1, 'PAUSED');
      await vi.waitFor(() => expect(writes).toEqual(['PAUSED']));
      const refresh = list.refresh();
      const middle = list.changeStatus(1, 'DROPPED');
      const last = list.changeStatus(1, 'PAUSED');
      reply(Response.json({ data: { SaveMediaListEntry: { ...entry(1, 65), status: 'PAUSED' } } }));
      await Promise.all([first, refresh, middle, last]);
      expect(reads.calls).toEqual(['full']);
      expect(writes).toEqual(remoteStatus === 'CURRENT' ? ['PAUSED', 'PAUSED'] : ['PAUSED']);
      expect(remote).toBe('PAUSED');
      expect(list.entries()?.[0].status).toBe('PAUSED');
      expect(store.saved?.entries[0].status).toBe('PAUSED');
    });

    it('rechecks a return to the displayed status while a read is in flight', async () => {
      let reply!: (response: Response) => void;
      const writes: string[] = [];
      list.useFetch(async (_url, init) => {
        const { query, variables } = JSON.parse(String(init?.body));
        if (!query.includes('SaveMediaListEntry')) return new Promise<Response>((resolve) => (reply = resolve));
        writes.push(variables.status);
        return Response.json({ data: { SaveMediaListEntry: { ...entry(1, 80), status: variables.status } } });
      });
      const refresh = list.refresh();
      await vi.waitFor(() => expect(reply).toBeDefined());
      const middle = list.changeStatus(1, 'DROPPED');
      const last = list.changeStatus(1, 'CURRENT');
      reply(
        Response.json({
          data: {
            MediaListCollection: { hasNextChunk: false, lists: [{ entries: [{ ...entry(1, 75), status: 'PAUSED' }] }] },
          },
        }),
      );
      await Promise.all([refresh, middle, last]);
      expect(writes).toEqual(['CURRENT']);
      expect(store.saved?.entries[0].status).toBe('CURRENT');
    });

    it.each(['delta', 'full'])(
      'keeps the offline warning when a %s read satisfies the pending choice before dispatch',
      async (kind) => {
        const rows = [
          { ...entry(1, 80), status: 'PAUSED' },
          { ...entry(2, 75), status: 'DROPPED' },
        ];
        const response = listFetch(200, rows, [rows]);
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const send = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          await held;
          return response.fn(url, init);
        });
        list.useFetch(send);
        vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));
        const now = store.saved!.checkedAt + CHANGES_INTERVAL_MS;
        const read = kind === 'delta' ? list.sync(me.id, now) : list.refresh(now);
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        const edit = list.changeStatus(1, 'PAUSED');
        release();
        await Promise.all([read, edit]);
        expect(response.calls).toEqual([kind === 'delta' ? 'changes' : 'full']);
        expect(list.entries()?.[0].status).toBe('PAUSED');
        expect(store.saved?.entries[0].status).toBe('CURRENT');
        expect([...list.unsavedMediaIds()]).toEqual([1]);
        expect(list.statusEdits().get(1)?.message).toBe('Saved to AniList.');
        await list.refresh(now);
        expect(list.unsavedMediaIds().size).toBe(0);
        expect(store.saved?.entries[0].status).toBe('PAUSED');
      },
    );

    it('keeps a cancelled tap quiet when a refresh returns the status already saved on the device', async () => {
      const response = listFetch(200);
      list.useFetch(response.fn);
      vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));
      const read = list.refresh();
      const edit = list.changeStatus(1, 'PAUSED');
      const undo = list.changeStatus(1, 'CURRENT');
      await Promise.all([read, edit, undo]);
      expect(response.calls).toEqual(['full']);
      expect(list.statusEdits().has(1)).toBe(false);
      expect(list.unsavedMediaIds().size).toBe(0);
      expect(store.saved?.entries[0].status).toBe('CURRENT');
    });

    it('acknowledges an undo confirmed by a refresh after the first change was written to the device', async () => {
      let reply!: (value: Response) => void;
      const reads = listFetch(200);
      const send = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(init?.body).includes('SaveMediaListEntry'))
          return new Promise<Response>((resolve) => (reply = resolve));
        return reads.fn(url, init);
      });
      list.useFetch(send);
      const write = store.write.bind(store);
      vi.spyOn(store, 'write').mockImplementationOnce(write).mockRejectedValueOnce(new Error('disk full'));
      const first = list.changeStatus(1, 'PAUSED');
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const read = list.refresh();
      const undo = list.changeStatus(1, 'CURRENT');
      reply(Response.json({ data: { SaveMediaListEntry: { ...entry(1, 60), status: 'PAUSED' } } }));
      await Promise.all([first, read, undo]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(reads.calls).toEqual(['full']);
      expect(list.entries()?.[0].status).toBe('CURRENT');
      expect(store.saved?.entries[0].status).toBe('PAUSED');
      expect([...list.unsavedMediaIds()]).toEqual([1]);
      expect(list.statusEdits().get(1)?.message).toBe('Saved to AniList.');
    });

    it.each(['delta', 'full'])(
      'warns only for edited titles first confirmed by a %s read that the device cannot save',
      async (kind) => {
        list.useFetch(async () => {
          throw new TypeError('reply lost');
        });
        await list.changeStatus(1, 'PAUSED');
        expect(list.statusEdits().get(1)?.problem).toBe(true);
        const changes = [
          { ...entry(1, 80), status: 'PAUSED' },
          { ...entry(2, 75), status: 'DROPPED' },
        ];
        list.useFetch(listFetch(200, changes, [changes]).fn);
        vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));
        const now = store.saved!.checkedAt + CHANGES_INTERVAL_MS;
        if (kind === 'delta') await list.sync(me.id, now);
        else await list.refresh(now);
        expect(list.entries()?.[0].status).toBe('PAUSED');
        expect(store.saved?.entries[0].status).toBe('CURRENT');
        expect(list.statusEdits().has(1)).toBe(false);
        expect([...list.unsavedMediaIds()]).toEqual([1]);
        await list.refresh(now);
        expect(store.saved?.entries[0].status).toBe('PAUSED');
        expect(list.unsavedMediaIds().size).toBe(0);
      },
    );

    it('does not flag the offline copy when the read confirms the original status after a lost reply', async () => {
      list.useFetch(async () => {
        throw new TypeError('reply lost');
      });
      await list.changeStatus(1, 'PAUSED');
      list.useFetch(listFetch(200).fn);
      vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));
      await list.refresh();
      expect(list.entries()?.[0].status).toBe('CURRENT');
      expect(list.statusEdits().has(1)).toBe(false);
      expect(list.unsavedMediaIds().size).toBe(0);
    });

    it.each(['delta', 'full'])(
      'retains a device warning across a failed %s save and clears it only when the whole file is written',
      async (kind) => {
        const write = vi.spyOn(store, 'write').mockRejectedValue(new Error('disk full'));
        const confirmed = { ...entry(1, 70), status: 'PAUSED' };
        list.useFetch(async () => Response.json({ data: { SaveMediaListEntry: confirmed } }));
        await list.changeStatus(1, 'PAUSED');
        list.useFetch(listFetch(200, [confirmed, entry(2, 50)], [[confirmed]]).fn);
        const now = store.saved!.checkedAt + CHANGES_INTERVAL_MS;
        if (kind === 'delta') await list.sync(me.id, now);
        else await list.refresh(now);
        expect(list.unsavedMediaIds().has(1)).toBe(true);
        expect(store.saved?.entries[0].status).toBe('CURRENT');
        write.mockRestore();
        // The next delta only mentions title 2, but the file contains both titles.
        list.useFetch(listFetch(200, [], [[entry(2, 85)]]).fn);
        await list.sync(me.id, now + CHANGES_INTERVAL_MS);
        expect(store.saved?.entries[0].status).toBe('PAUSED');
        expect(list.unsavedMediaIds().size).toBe(0);
      },
    );

    it('a successful edit on another title repairs the device copy without clearing an unrelated remote error', async () => {
      const write = vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));
      list.useFetch(async () => Response.json({ data: { SaveMediaListEntry: { ...entry(1, 65), status: 'PAUSED' } } }));
      await list.changeStatus(1, 'PAUSED');
      write.mockRestore();
      list.useFetch(async () => Response.json({}, { status: 503 }));
      const next = list.changeStatus(1, 'DROPPED');
      expect(list.statusEdits().get(1)).toMatchObject({ pending: 'DROPPED', message: 'Saving to AniList…' });
      await next;
      expect(list.unsavedMediaIds().has(1)).toBe(true);
      list.useFetch(async () =>
        Response.json({ data: { SaveMediaListEntry: { ...entry(2, 80), status: 'COMPLETED' } } }),
      );
      await list.changeStatus(2, 'COMPLETED');
      expect(list.unsavedMediaIds().size).toBe(0);
      expect(list.statusEdits().get(1)?.message).toContain('Could not confirm');
      expect(store.saved?.entries.map((item) => item.status)).toEqual(['PAUSED', 'COMPLETED']);
    });

    it.each(['edit', 'delta'])(
      'retires an old-entry warning when the replacement is confirmed by a later %s',
      async (action) => {
        const replacement = entry(3, 70, 1);
        const delta = listFetch(200, [], [[replacement]]);
        list.useFetch(delta.fn);
        const pending = list.changeStatus(1, 'PAUSED');
        const now = store.saved!.checkedAt + CHANGES_INTERVAL_MS;
        await list.sync(me.id, now);
        await pending;
        expect(delta.calls).toEqual(['changes']);
        expect(list.statusEdits().get(1)?.message).toContain('replaced');
        expect(list.entries()?.find((item) => item.id === 3)?.status).toBe('CURRENT');
        if (action === 'delta') {
          await list.sync(me.id, now + CHANGES_INTERVAL_MS);
          expect(delta.calls).toEqual(['changes', 'changes']);
        } else {
          const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body)).variables).toEqual({ id: 3, status: 'PAUSED' });
            return Response.json({ data: { SaveMediaListEntry: { ...replacement, status: 'PAUSED' } } });
          });
          list.useFetch(send);
          await list.changeStatus(3, 'PAUSED');
          expect(send).toHaveBeenCalledTimes(1);
          expect(list.statusEdits().get(3)?.message).toBe('Saved to AniList.');
        }
        expect(list.statusEdits().has(1)).toBe(false);
      },
    );

    it.each([1, 3])('clears only the settled error for the anime returned on resume (entry %i)', async (returnedId) => {
      list.useFetch(async () => {
        throw new Error('Reply lost');
      });
      await Promise.all([list.changeStatus(1, 'PAUSED'), list.changeStatus(2, 'DROPPED')]);
      expect(list.statusEdits().get(1)?.message).toContain('Could not confirm');
      const updated = { ...entry(returnedId, 70, 1), status: 'PAUSED' };
      const delta = listFetch(200, [], [[updated]]);
      list.useFetch(delta.fn);
      list.resume(store.saved!.checkedAt + CHANGES_INTERVAL_MS);
      await vi.waitFor(() => expect(list.entries()?.find((item) => item.id === returnedId)?.status).toBe('PAUSED'));
      expect(delta.calls).toEqual(['changes']);
      expect(list.statusEdits().has(1)).toBe(false);
      expect(list.statusEdits().get(2)?.message).toContain('Could not confirm');
    });

    it('keeps a newer pending edit when a delta is received for the same entry', async () => {
      let reply!: (response: Response) => void;
      const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (String(init?.body).includes('UPDATED_TIME_DESC'))
          return new Promise<Response>((resolve) => (reply = resolve));
        return Response.json({ data: { SaveMediaListEntry: { ...entry(1, 80), status: 'DROPPED' } } });
      });
      list.useFetch(send);
      const sync = list.sync(me.id, store.saved!.checkedAt + CHANGES_INTERVAL_MS);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const pending = list.changeStatus(1, 'DROPPED');
      reply(
        Response.json({
          data: { Page: { pageInfo: { hasNextPage: false }, mediaList: [{ ...entry(1, 70), status: 'PAUSED' }] } },
        }),
      );
      await sync;
      expect(list.statusEdits().get(1)?.pending).toBe('DROPPED');
      await pending;
      expect(store.saved?.entries[0].status).toBe('DROPPED');
    });

    it('keeps a later choice on the same title when the first confirmation arrives', async () => {
      let reply!: (response: Response) => void;
      const send = vi
        .fn()
        .mockImplementationOnce(() => new Promise<Response>((r) => (reply = r)))
        .mockResolvedValueOnce(Response.json({ data: { SaveMediaListEntry: { ...entry(1, 62), status: 'DROPPED' } } }));
      list.useFetch(send);
      const first = list.changeStatus(1, 'PAUSED');
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const last = list.changeStatus(1, 'DROPPED');
      reply(Response.json({ data: { SaveMediaListEntry: { ...entry(1, 61), status: 'PAUSED' } } }));
      await first;
      expect(list.statusEdits().get(1)?.pending).toBe('DROPPED');
      await last;
      expect(store.saved?.entries[0].status).toBe('DROPPED');
      expect(list.statusEdits().get(1)?.pending).toBe(null);
    });
  });
});
