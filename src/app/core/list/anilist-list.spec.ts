import { UnauthorizedError } from '../auth/anilist-viewer';

import { fetchChanges, fetchList, RateLimitedError, saveStatus } from './anilist-list';

const raw = (id: number, updatedAt = 100) => ({
  id,
  status: 'CURRENT',
  progress: 3,
  repeat: null,
  updatedAt,
  score: 8.5,
  startedAt: { year: 2025, month: null, day: null },
  completedAt: null,
  media: {
    id: id * 10,
    format: 'TV',
    episodes: 12,
    status: 'RELEASING',
    season: 'FALL',
    seasonYear: 2026,
    title: { romaji: `Romaji ${id}`, english: null },
    coverImage: { large: `https://s4.anilist.co/${id}.jpg` },
    nextAiringEpisode: { episode: 4, airingAt: 1_800_000_000 },
  },
});

const page = (entries: unknown[], hasNextChunk = false) => ({
  data: { MediaListCollection: { hasNextChunk, lists: [{ entries }] } },
});

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { chunk: number; userId: number; auth: string }[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body)) as { variables: { chunk: number; userId: number } };
    calls.push({ ...variables, auth: (init.headers as Record<string, string>)['Authorization'] });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('fetchList', () => {
  it.each([
    { ...page([raw(1)]), errors: [{ message: 'Group unavailable' }] },
    { data: { MediaListCollection: { hasNextChunk: false, lists: null } } },
    { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries: null }] } } },
    { data: { MediaListCollection: { hasNextChunk: null, lists: [] } } },
  ])('rejects an incomplete final chunk instead of returning the earlier rows', async (body) => {
    const { fn } = fakeFetch([
      { status: 200, body: page([raw(2)], true) },
      { status: 200, body },
    ]);
    await expect(fetchList('tok', 7, fn, 0)).rejects.toThrow();
  });

  it('accepts a complete empty list', async () => {
    const { fn } = fakeFetch([{ status: 200, body: page([]) }]);
    await expect(fetchList('tok', 7, fn)).resolves.toEqual([]);
  });
  it('reads the whole list in one call and maps the fields', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: page([raw(1), raw(2)]) }]);
    const entries = await fetchList('tok', 7, fn);
    expect(calls).toEqual([{ chunk: 1, userId: 7, perChunk: 500, auth: 'Bearer tok' } as never]);
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual({
      id: 1,
      status: 'CURRENT',
      progress: 3,
      score: 8.5,
      startedAt: { year: 2025, month: null, day: null },
      completedAt: null,
      repeat: 0,
      updatedAt: 100,
      media: {
        id: 10,
        title: { romaji: 'Romaji 1', english: null },
        cover: 'https://s4.anilist.co/1.jpg',
        format: 'TV',
        episodes: 12,
        status: 'RELEASING',
        season: 'FALL',
        seasonYear: 2026,
        nextEpisode: { episode: 4, airingAt: 1_800_000_000 },
      },
    });
  });

  it('asks for the next chunk while AniList says there is one, and keeps each entry once', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: page([raw(1), raw(2)], true) },
      { status: 200, body: page([raw(2), raw(3)]) },
    ]);
    const entries = await fetchList('tok', 7, fn, 0);
    expect(calls.map((c) => c.chunk)).toEqual([1, 2]);
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('skips entries whose media AniList no longer returns', async () => {
    const { fn } = fakeFetch([{ status: 200, body: page([{ ...raw(1), media: null }, raw(2)]) }]);
    expect((await fetchList('tok', 7, fn)).map((e) => e.id)).toEqual([2]);
  });

  it('throws UnauthorizedError on 401 and on an invalid-token error', async () => {
    await expect(fetchList('tok', 7, fakeFetch([{ status: 401, body: {} }]).fn)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    const invalid = { errors: [{ message: 'Invalid token' }] };
    await expect(fetchList('tok', 7, fakeFetch([{ status: 400, body: invalid }]).fn)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('throws RateLimitedError on 429 and does not retry', async () => {
    const { fn, calls } = fakeFetch([{ status: 429, body: {} }]);
    await expect(fetchList('tok', 7, fn)).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls.length).toBe(1);
  });

  it('throws a plain error on a server error', async () => {
    const { fn } = fakeFetch([{ status: 500, body: { errors: [{ message: 'down' }] } }]);
    await expect(fetchList('tok', 7, fn)).rejects.toThrow('AniList list request failed (500).');
  });
});

const changesPage = (entries: unknown[], hasNextPage = false) => ({
  data: { Page: { pageInfo: { hasNextPage }, mediaList: entries } },
});

describe('saveStatus', () => {
  it('updates an existing entry by id and asks for its confirmed list fields', async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.query).toContain('SaveMediaListEntry(id: $id, status: $status)');
      expect(sent.variables).toEqual({ id: 3, status: 'PAUSED' });
      expect(sent.query).toContain('completedAt');
      return Response.json({ data: { SaveMediaListEntry: { ...raw(3), status: 'PAUSED' } } });
    });
    const result = await saveStatus('tok', 3, 'PAUSED', send, {});
    expect(result).toMatchObject({
      id: 3,
      status: 'PAUSED',
      score: 8.5,
      startedAt: { year: 2025, month: null, day: null },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { data: { SaveMediaListEntry: null } },
    { data: { SaveMediaListEntry: raw(2) } },
    { data: { SaveMediaListEntry: { ...raw(3), status: 'PLANNING' } } },
    { data: { SaveMediaListEntry: raw(3) }, errors: [{ message: 'Incomplete result' }] },
  ])('requires a complete confirmation for the requested entry and status', async (body) => {
    await expect(saveStatus('tok', 3, 'CURRENT', async () => Response.json(body), {})).rejects.toThrow();
  });
});

function pagesFetch(pages: unknown[]) {
  const asked: number[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { page: number } };
    expect(query).toContain('sort: UPDATED_TIME_DESC');
    asked.push(variables.page);
    return new Response(JSON.stringify(pages[variables.page - 1]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, asked };
}

describe('fetchChanges', () => {
  it('rejects a partial changes page instead of advancing the watermark', async () => {
    const { fn } = pagesFetch([{ ...changesPage([raw(1, 300)]), errors: [{ message: 'Partial page' }] }]);
    await expect(fetchChanges('tok', 7, 200, fn, 0)).rejects.toThrow();
  });
  it('returns the entries changed since the watermark, the same second included, and stops at the first older one', async () => {
    const { fn, asked } = pagesFetch([
      changesPage([raw(1, 300), raw(2, 200), raw(3, 200), raw(4, 199), raw(5, 400)], true),
    ]);
    const changed = await fetchChanges('tok', 7, 200, fn, 0);
    expect(changed?.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(asked).toEqual([1]);
  });

  it('reads the next page while every entry on it is new enough', async () => {
    const { fn, asked } = pagesFetch([changesPage([raw(1, 300)], true), changesPage([raw(2, 250), raw(3, 100)], true)]);
    expect((await fetchChanges('tok', 7, 200, fn, 0))?.map((e) => e.id)).toEqual([1, 2]);
    expect(asked).toEqual([1, 2]);
  });

  it('stops when AniList has no more pages', async () => {
    const { fn, asked } = pagesFetch([changesPage([raw(1, 300)])]);
    expect((await fetchChanges('tok', 7, 200, fn, 0))?.map((e) => e.id)).toEqual([1]);
    expect(asked).toEqual([1]);
  });

  it('returns null after 10 pages of changes, so the caller fetches the whole list', async () => {
    const pages = Array.from({ length: 11 }, (_, i) => changesPage([raw(i + 1, 300)], true));
    const { fn, asked } = pagesFetch(pages);
    expect(await fetchChanges('tok', 7, 200, fn, 0)).toBeNull();
    expect(asked.length).toBe(10);
  });

  it('skips a changed entry whose media AniList no longer returns', async () => {
    const { fn } = pagesFetch([changesPage([{ ...raw(1, 300), media: null }, raw(2, 300)])]);
    expect((await fetchChanges('tok', 7, 200, fn, 0))?.map((e) => e.id)).toEqual([2]);
  });

  it('throws like fetchList on 401 and 429', async () => {
    await expect(fetchChanges('tok', 7, 0, fakeFetch([{ status: 401, body: {} }]).fn)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(fetchChanges('tok', 7, 0, fakeFetch([{ status: 429, body: {} }]).fn)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});
