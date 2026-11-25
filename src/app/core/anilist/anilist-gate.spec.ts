import { AniListGate } from './anilist-gate';

function setup(responses: { status: number; remaining?: number; reset?: number }[]) {
  let now = 1_000_000;
  const slept: number[] = [];
  const order: string[] = [];
  const gate = new AniListGate(
    () => now,
    async (ms) => {
      slept.push(ms);
      now += ms;
    },
  );
  const fn = (async (url: string) => {
    order.push(url);
    const next = responses.shift()!;
    const headers: Record<string, string> = {};
    if (next.remaining !== undefined) headers['X-RateLimit-Remaining'] = String(next.remaining);
    if (next.reset !== undefined) headers['X-RateLimit-Reset'] = String(next.reset);
    return new Response('{}', { status: next.status, headers });
  }) as unknown as typeof fetch;
  return { gate, fn, slept, order, at: () => now };
}

describe('AniListGate', () => {
  it('sends calls one at a time, in order', async () => {
    const { gate, fn, order } = setup([{ status: 200 }, { status: 200 }]);
    await Promise.all([gate.send(fn, 'a', {}), gate.send(fn, 'b', {})]);
    expect(order).toEqual(['a', 'b']);
  });

  it('waits for the reset before the next call when only 2 calls are left in the minute', async () => {
    const { gate, fn, slept } = setup([
      { status: 200, remaining: 2, reset: 1_020 },
      { status: 200, remaining: 29 },
    ]);
    await gate.send(fn, 'a', {});
    expect(slept).toEqual([]);
    await gate.send(fn, 'b', {});
    expect(slept).toEqual([20_000]);
  });

  it('on 429 without retry returns the 429 and makes the next call wait', async () => {
    const { gate, fn, slept } = setup([{ status: 429, remaining: 0, reset: 1_052 }, { status: 200 }]);
    expect((await gate.send(fn, 'a', {})).status).toBe(429);
    await gate.send(fn, 'b', {});
    expect(slept).toEqual([52_000]);
  });

  it('on 429 with retry says how long, waits, and tries exactly once more', async () => {
    const { gate, fn, slept, order } = setup([
      { status: 429, remaining: 0, reset: 1_052 },
      { status: 429, remaining: 0, reset: 1_112 },
    ]);
    const waits: number[] = [];
    const response = await gate.send(fn, 'a', {}, { retry: true, onWait: (s) => waits.push(s) });
    expect(response.status).toBe(429);
    expect(order).toEqual(['a', 'a']);
    expect(waits).toEqual([52]);
    expect(slept).toEqual([52_000]);
  });

  it('waits 60 s when AniList gives no reset time, and never more than 60 s or less than 1 s', async () => {
    const none = setup([{ status: 429 }, { status: 200 }]);
    await none.gate.send(none.fn, 'a', {});
    await none.gate.send(none.fn, 'b', {});
    expect(none.slept).toEqual([60_000]);

    const far = setup([{ status: 429, reset: 99_999 }, { status: 200 }]);
    await far.gate.send(far.fn, 'a', {});
    await far.gate.send(far.fn, 'b', {});
    expect(far.slept).toEqual([60_000]);

    const past = setup([{ status: 429, reset: 900 }, { status: 200 }]);
    await past.gate.send(past.fn, 'a', {});
    await past.gate.send(past.fn, 'b', {});
    expect(past.slept).toEqual([1_000]);
  });

  it('a failed call does not stop the calls after it', async () => {
    const { gate, order } = setup([]);
    const failing = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    const ok = (async (url: string) => {
      order.push(url);
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(gate.send(failing, 'a', {})).rejects.toThrow('offline');
    await gate.send(ok, 'b', {});
    expect(order).toEqual(['b']);
  });
});
