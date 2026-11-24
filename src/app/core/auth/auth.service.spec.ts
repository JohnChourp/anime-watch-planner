import { TestBed } from '@angular/core/testing';

import { AuthPlatform } from './auth-platform';
import type { StoredToken } from './auth-redirect';
import { AuthService } from './auth.service';

class FakePlatform {
  saved: StoredToken | null = null;
  opened: string[] = [];
  closed = 0;
  redirect?: (url: string) => void;
  async openSignIn(url: string) {
    this.opened.push(url);
  }
  async closeSignIn() {
    this.closed++;
  }
  async onRedirect(handler: (url: string) => void) {
    this.redirect = handler;
  }
  async onSignInClosed() {}
  async readToken() {
    return this.saved;
  }
  async writeToken(token: StoredToken) {
    this.saved = token;
  }
  async deleteToken() {
    this.saved = null;
  }
}

const viewerResponse = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('AuthService', () => {
  let platform: FakePlatform;
  let auth: AuthService;
  const now = 1_000_000;

  beforeEach(() => {
    platform = new FakePlatform();
    TestBed.configureTestingModule({ providers: [{ provide: AuthPlatform, useValue: platform }] });
    auth = TestBed.inject(AuthService);
    auth.useFetch(viewerResponse(200, { data: { Viewer: { id: 7, name: 'Tester' } } }));
  });

  it('starts signed out without a saved token', async () => {
    await auth.start(now);
    expect(auth.status()).toBe('signedOut');
    expect(auth.message()).toBeNull();
  });

  it('restores a saved, valid token and loads the viewer', async () => {
    platform.saved = { accessToken: 't', expiresAt: now + 1000 };
    await auth.start(now);
    expect(auth.status()).toBe('signedIn');
    expect(auth.viewer()).toEqual({ id: 7, name: 'Tester' });
    expect(auth.accessToken(now)).toBe('t');
  });

  it('signs out with a message when the saved token has expired', async () => {
    platform.saved = { accessToken: 't', expiresAt: now };
    await auth.start(now);
    expect(auth.status()).toBe('signedOut');
    expect(platform.saved).toBeNull();
    expect(auth.message()).toContain('sign in again');
  });

  it('signs out with a message when AniList answers 401', async () => {
    platform.saved = { accessToken: 't', expiresAt: now + 1000 };
    auth.useFetch(viewerResponse(401, { errors: [{ status: 401, message: 'Invalid token' }] }));
    await auth.start(now);
    expect(auth.status()).toBe('signedOut');
    expect(platform.saved).toBeNull();
  });

  it('stays signed in when AniList cannot be reached', async () => {
    platform.saved = { accessToken: 't', expiresAt: now + 1000 };
    auth.useFetch((async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch);
    await auth.start(now);
    expect(auth.status()).toBe('signedIn');
    expect(auth.viewer()).toBeNull();
  });

  it('saves the token from the redirect and closes the sign-in page', async () => {
    await auth.start(now);
    await auth.handleRedirect('com.john.animewatchplanner://auth#access_token=new&expires_in=60', now);
    expect(platform.saved).toEqual({ accessToken: 'new', expiresAt: now + 60_000 });
    expect(platform.closed).toBe(1);
    expect(auth.status()).toBe('signedIn');
    expect(auth.viewer()?.name).toBe('Tester');
  });

  it('shows the reason when sign-in fails', async () => {
    await auth.start(now);
    await auth.handleRedirect('com.john.animewatchplanner://auth?error=access_denied', now);
    expect(auth.status()).toBe('signedOut');
    expect(auth.message()).toContain('access_denied');
    expect(platform.saved).toBeNull();
  });

  it('sign out forgets the token', async () => {
    platform.saved = { accessToken: 't', expiresAt: now + 1000 };
    await auth.start(now);
    await auth.signOut();
    expect(platform.saved).toBeNull();
    expect(auth.status()).toBe('signedOut');
    expect(auth.accessToken(now)).toBeNull();
  });

  it('closing the sign-in page returns to the sign-in screen', async () => {
    await auth.start(now);
    auth.status.set('signingIn');
    auth.cancelSignIn();
    expect(auth.status()).toBe('signedOut');
  });
});
