import { ANILIST } from './anilist.config';

export interface StoredToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type AuthRedirect = { kind: 'token'; token: StoredToken } | { kind: 'error'; reason: string };

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

  const error = params.get('error');
  if (error) {
    return { kind: 'error', reason: params.get('error_description') ?? error };
  }
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in'));
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { kind: 'error', reason: 'AniList did not return a sign-in token.' };
  }
  return { kind: 'token', token: { accessToken, expiresAt: now + expiresIn * 1000 } };
}

export function authorizeUrl(): string {
  const params = new URLSearchParams({ client_id: ANILIST.clientId, response_type: 'token' });
  return `${ANILIST.authorizeUrl}?${params.toString()}`;
}
