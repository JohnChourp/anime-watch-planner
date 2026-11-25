import { UnauthorizedError } from '../auth/anilist-viewer';

import { fetchList, RateLimitedError } from './anilist-list';

const raw = (id: number, updatedAt = 100) => ({
  id,
  status: 'CURRENT',
  progress: 3,
  repeat: null,
  updatedAt,
  score: 8.5,
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
