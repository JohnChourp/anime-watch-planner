import { ANILIST } from './anilist.config';

export interface StoredToken {
  accessToken: string;
  /** Local identifier for an offline list verified during this sign-in. */
  sessionId?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A sign-in the user started: its random `state`, sent to AniList and expected back. */
export interface PendingSignIn {
  state: string;
  /** Epoch milliseconds. */
  startedAt: number;
}

export type AuthRedirect = ({ kind: 'token'; token: StoredToken } | { kind: 'error'; reason: string }) & {
  /** The `state` AniList sent back, if any. */
  state: string | null;
};

/**
 * Reads the AniList Implicit Grant redirect, e.g.
 * `com.john.animewatchplanner://auth#access_token=…&token_type=Bearer&expires_in=31536000`.
 * Returns null for any URL that is not our auth redirect.
 */
export function parseAuthRedirect(url: string, now = Date.now()): AuthRedirect | null {
  if (!url.startsWith(ANILIST.redirectUri)) {
    return null;
  }
  const rest = url.slice(ANILIST.redirectUri.length);
  if (rest !== '' && !rest.startsWith('#') && !rest.startsWith('?') && !rest.startsWith('/')) {
    return null;
  }
  const hashIndex = url.indexOf('#');
  const queryIndex = url.indexOf('?');
  const params = new URLSearchParams(
    hashIndex >= 0 ? url.slice(hashIndex + 1) : queryIndex >= 0 ? url.slice(queryIndex + 1) : '',
  );

  const state = params.get('state');
  const error = params.get('error');
  if (error) {
    return { kind: 'error', reason: params.get('error_description') ?? error, state };
  }
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in'));
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { kind: 'error', reason: 'AniList did not return a sign-in token.', state };
  }
  return { kind: 'token', token: { accessToken, expiresAt: now + expiresIn * 1000 }, state };
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({ client_id: ANILIST.clientId, response_type: 'token', state });
  return `${ANILIST.authorizeUrl}?${params.toString()}`;
}
