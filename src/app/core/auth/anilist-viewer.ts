import { anilistGate } from '../anilist/anilist-gate';

import { ANILIST } from './anilist.config';

export interface Viewer {
  id: number;
  name: string;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('AniList rejected the sign-in token.');
  }
}

/** One GraphQL call: who owns this token. Throws UnauthorizedError on 401 or an invalid token. */
export async function fetchViewer(accessToken: string, fetchFn: typeof fetch = fetch): Promise<Viewer> {
  const response = await anilistGate.send(fetchFn, ANILIST.graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: '{ Viewer { id name } }' }),
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  const body = (await response.json().catch(() => ({}))) as {
    data?: { Viewer?: Viewer | null };
    errors?: { status?: number; message?: string }[];
  };
  if (body.errors?.some((e) => e.status === 401 || /invalid token/i.test(e.message ?? ''))) {
    throw new UnauthorizedError();
  }
  if (!response.ok || !body.data?.Viewer) {
    throw new Error(`AniList Viewer request failed (${response.status}).`);
  }
  return body.data.Viewer;
}
