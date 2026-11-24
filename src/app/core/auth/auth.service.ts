import { Injectable, inject, signal } from '@angular/core';

import { fetchViewer, UnauthorizedError, type Viewer } from './anilist-viewer';
import { ANILIST } from './anilist.config';
import { AuthPlatform } from './auth-platform';
import { authorizeUrl, parseAuthRedirect, type StoredToken } from './auth-redirect';

export type AuthStatus = 'loading' | 'signedOut' | 'signingIn' | 'signedIn';

export const FETCH = Symbol('fetch');

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly platform = inject(AuthPlatform);
  private fetchFn: typeof fetch = (...args) => fetch(...args);
  private token: StoredToken | null = null;
  private started = false;

  readonly status = signal<AuthStatus>('loading');
  readonly viewer = signal<Viewer | null>(null);
  /** A short, plain message for the sign-in screen (expired session, cancelled sign-in, …). */
  readonly message = signal<string | null>(null);

  /** For tests only. */
  useFetch(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  /** Call once at start-up: listens for the sign-in redirect and restores a saved session. */
  async start(now = Date.now()): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.platform.onRedirect((url) => void this.handleRedirect(url));
    await this.platform.onSignInClosed(() => this.cancelSignIn());

    const saved = await this.platform.readToken();
    if (!saved) {
      this.status.set('signedOut');
      return;
    }
    if (saved.expiresAt <= now) {
      await this.expire();
      return;
    }
    this.token = saved;
    this.status.set('signedIn');
    await this.loadViewer();
  }

  /** The AniList Bearer token for API calls, or null when signed out. */
  accessToken(now = Date.now()): string | null {
    return this.token && this.token.expiresAt > now ? this.token.accessToken : null;
  }

  async signIn(): Promise<void> {
    if (!ANILIST.clientId) {
      this.message.set('Sign-in is not set up yet: the AniList client id is missing.');
      return;
    }
    this.message.set(null);
    this.status.set('signingIn');
    try {
      await this.platform.openSignIn(authorizeUrl());
    } catch {
      this.status.set('signedOut');
      this.message.set('Could not open the AniList sign-in page.');
    }
  }

  /** Back to the sign-in screen without a message, e.g. when the user closes the AniList page. */
  cancelSignIn(): void {
    if (this.status() === 'signingIn') {
      this.status.set('signedOut');
    }
  }

  async handleRedirect(url: string, now = Date.now()): Promise<void> {
    const result = parseAuthRedirect(url, now);
    if (!result) {
      return;
    }
    await this.platform.closeSignIn();
    if (result.kind === 'error') {
      this.status.set('signedOut');
      this.message.set(`Sign-in did not finish: ${result.reason}`);
      return;
    }
    await this.platform.writeToken(result.token);
    this.token = result.token;
    this.message.set(null);
    this.status.set('signedIn');
    await this.loadViewer();
  }

  /** Signs out on this device: forgets the token. (The list cache is cleared here too once it exists, 3.1.) */
  async signOut(): Promise<void> {
    await this.platform.deleteToken();
    this.token = null;
    this.viewer.set(null);
    this.message.set(null);
    this.status.set('signedOut');
  }

  /** Any AniList call that gets a 401 calls this: the user signs in again, with a clear message. */
  async expire(): Promise<void> {
    await this.signOut();
    this.message.set('Your AniList session has ended. Please sign in again.');
  }

  private async loadViewer(): Promise<void> {
    const token = this.token;
    if (!token) {
      return;
    }
    try {
      this.viewer.set(await fetchViewer(token.accessToken, this.fetchFn));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        await this.expire();
      }
      // Offline or AniList down: stay signed in; the name shows up next time.
    }
  }
}
