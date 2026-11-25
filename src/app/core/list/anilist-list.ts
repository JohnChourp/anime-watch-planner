import { UnauthorizedError } from '../auth/anilist-viewer';
import { ANILIST } from '../auth/anilist.config';

/** AniList list statuses; the app's six states map 1:1 to them. */
export type ListStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING';

/** One entry of the user's anime list, with only the fields the list screens need (decided 2026-11-25). */
export interface ListEntry {
  id: number;
  status: ListStatus;
  progress: number;
  /** 0–10; 0 means "no score given". */
  score: number;
  repeat: number;
  /** AniList server time, in seconds. */
  updatedAt: number;
  media: {
    id: number;
    /** Both kept, so the list screens can follow the user's AniList title language later. */
    title: { romaji: string | null; english: string | null };
    cover: string | null;
    format: string | null;
    episodes: number | null;
    status: string | null;
    season: string | null;
    seasonYear: number | null;
    nextEpisode: { episode: number; airingAt: number } | null;
  };
}

/** AniList answered 429: too many requests. No retry here; task 3.3 adds waiting and retrying. */
export class RateLimitedError extends Error {
  constructor() {
    super('AniList is getting too many requests.');
  }
}

/** AniList caps perChunk at 500, so a list of up to 500 entries is one call. */
const PER_CHUNK = 500;
/** A guard against a server that never says "no next chunk": 20 × 500 = 10,000 entries. */
const MAX_CHUNKS = 20;
/** A pause between chunks, so a big list does not trip AniList's burst limiter (full limit handling: 3.3). */
const CHUNK_PAUSE_MS = 1500;

const QUERY = `query ($userId: Int, $chunk: Int, $perChunk: Int) {
  MediaListCollection(userId: $userId, type: ANIME, chunk: $chunk, perChunk: $perChunk, forceSingleCompletedList: true) {
    hasNextChunk
    lists {
      entries {
        id status progress repeat updatedAt
        score(format: POINT_10_DECIMAL)
        media {
          id format episodes status season seasonYear
          title { romaji english }
          coverImage { large }
          nextAiringEpisode { episode airingAt }
        }
      }
    }
  }
}`;

interface RawEntry {
  id: number;
  status: ListStatus;
  progress: number | null;
  repeat: number | null;
  updatedAt: number | null;
  score: number | null;
  media: {
    id: number;
    format: string | null;
    episodes: number | null;
    status: string | null;
    season: string | null;
    seasonYear: number | null;
    title: { romaji: string | null; english: string | null } | null;
    coverImage: { large: string | null } | null;
    nextAiringEpisode: { episode: number; airingAt: number } | null;
  } | null;
}

interface CollectionResponse {
  data?: {
    MediaListCollection?: { hasNextChunk: boolean | null; lists: { entries: RawEntry[] | null }[] | null } | null;
  };
  errors?: { status?: number; message?: string }[];
}

/**
 * The user's whole anime list, private entries included: one call per 500 entries, sent one after another.
 * Throws UnauthorizedError on 401 or an invalid token, RateLimitedError on 429, Error otherwise.
 */
export async function fetchList(
  accessToken: string,
  userId: number,
  fetchFn: typeof fetch = fetch,
  pauseMs = CHUNK_PAUSE_MS,
): Promise<ListEntry[]> {
  const byId = new Map<number, ListEntry>();
  for (let chunk = 1; chunk <= MAX_CHUNKS; chunk++) {
    if (chunk > 1) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    const response = await fetchFn(ANILIST.graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: QUERY, variables: { userId, chunk, perChunk: PER_CHUNK } }),
    });
    if (response.status === 401) {
      throw new UnauthorizedError();
    }
    if (response.status === 429) {
      throw new RateLimitedError();
    }
    const body = (await response.json().catch(() => ({}))) as CollectionResponse;
    if (body.errors?.some((e) => e.status === 401 || /invalid token/i.test(e.message ?? ''))) {
      throw new UnauthorizedError();
    }
    if (body.errors?.some((e) => e.status === 429)) {
      throw new RateLimitedError();
    }
    const collection = body.data?.MediaListCollection;
    if (!response.ok || !collection) {
      throw new Error(`AniList list request failed (${response.status}).`);
    }
    // Custom lists repeat entries, so keep each entry id once.
    for (const list of collection.lists ?? []) {
      for (const raw of list.entries ?? []) {
        const entry = toEntry(raw);
        if (entry) {
          byId.set(entry.id, entry);
        }
      }
    }
    if (!collection.hasNextChunk) {
      return [...byId.values()];
    }
  }
  throw new Error('AniList kept sending more of the list than expected.');
}

function toEntry(raw: RawEntry): ListEntry | null {
  const media = raw.media;
  if (!media) {
    return null;
  }
  return {
    id: raw.id,
    status: raw.status,
    progress: raw.progress ?? 0,
    score: raw.score ?? 0,
    repeat: raw.repeat ?? 0,
    updatedAt: raw.updatedAt ?? 0,
    media: {
      id: media.id,
      title: { romaji: media.title?.romaji ?? null, english: media.title?.english ?? null },
      cover: media.coverImage?.large ?? null,
      format: media.format,
      episodes: media.episodes,
      status: media.status,
      season: media.season,
      seasonYear: media.seasonYear,
      nextEpisode: media.nextAiringEpisode,
    },
  };
}
