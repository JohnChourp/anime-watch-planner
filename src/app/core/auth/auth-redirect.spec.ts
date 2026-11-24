import { parseAuthRedirect } from './auth-redirect';

describe('parseAuthRedirect', () => {
  const now = 1_000_000;

  it('reads the token and expiry from the fragment', () => {
    const result = parseAuthRedirect(
      'com.john.animewatchplanner://auth#access_token=abc.def&token_type=Bearer&expires_in=31536000',
      now,
    );
    expect(result).toEqual({
      kind: 'token',
      token: { accessToken: 'abc.def', expiresAt: now + 31_536_000_000 },
      state: null,
    });
  });

  it('reports an AniList error', () => {
    const result = parseAuthRedirect(
      'com.john.animewatchplanner://auth?error=access_denied&error_description=The+user+denied',
      now,
    );
    expect(result).toEqual({ kind: 'error', reason: 'The user denied', state: null });
  });

  it('treats a redirect without a token as an error', () => {
    expect(parseAuthRedirect('com.john.animewatchplanner://auth#token_type=Bearer', now)?.kind).toBe('error');
    expect(parseAuthRedirect('com.john.animewatchplanner://auth#access_token=x&expires_in=0', now)?.kind).toBe('error');
  });

  it('returns the state AniList sent back', () => {
    expect(
      parseAuthRedirect('com.john.animewatchplanner://auth#access_token=x&expires_in=10&state=abc', now)?.state,
    ).toBe('abc');
  });

  it('ignores URLs that are not our redirect', () => {
    expect(parseAuthRedirect('https://anilist.co/#access_token=x&expires_in=10', now)).toBeNull();
    expect(parseAuthRedirect('com.john.animewatchplanner://authx#access_token=x&expires_in=10', now)).toBeNull();
  });
});
