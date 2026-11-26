import { Injectable, computed, inject, signal } from '@angular/core';

import { fetchViewer, UnauthorizedError, type Viewer } from './anilist-viewer';
import { ANILIST } from './anilist.config';
import { AuthPlatform } from './auth-platform';
import { authorizeUrl, parseAuthRedirect, type StoredToken } from './auth-redirect';

export type AuthStatus = 'loading' | 'signedOut' | 'signingIn' | 'signedIn';

/** A redirect is accepted only within this time after the user tapped "Sign in". */
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly platform = inject(AuthPlatform);
  private fetchFn: typeof fetch = (...args) => fetch(...args);
  private readonly token = signal<StoredToken | null>(null);
  private started = false;

  readonly status = signal<AuthStatus>('loading');
  readonly viewer = signal<Viewer | null>(null);
  readonly sessionId = computed(() => this.token()?.sessionId);
  /** A short, plain message for the sign-in screen (expired session, failed sign-in, …). */
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
    try {
      await this.platform.onRedirect((url) => void this.handleRedirect(url));
      await this.platform.onSignInClosed(() => this.cancelSignIn());
    } catch {
      // Without the listeners sign-in cannot finish, but a saved session still works.
    }

    let saved: StoredToken | null = null;
    try {
      saved = await this.platform.readToken();
    } catch {
      // Unreadable secure storage (e.g. Android Keystore key reset after a screen-lock change).
      await this.signOut().catch(() => undefined);
      this.message.set('Please sign in again.');
    }
    if (saved && saved.expiresAt <= now) {
      await this.expire();
    } else if (saved) {
      if (!saved.sessionId) {
        // Upgrade older sessions without discarding a valid sign-in if secure storage is full.
        saved = { ...saved, sessionId: crypto.randomUUID() };
        await this.platform.writeToken(saved).catch(() => undefined);
      }
      this.token.set(saved);
      this.status.set('signedIn');
      await this.loadViewer();
    } else if (this.status() === 'loading') {
      this.status.set('signedOut');
    }

    // The redirect may have cold-started the app (Android can kill it while the AniList page is open).
    const launchUrl = await this.platform.launchUrl().catch(() => null);
    if (launchUrl) {
      await this.handleRedirect(launchUrl, now);
    }
  }

  /** The AniList Bearer token for API calls, or null when signed out. An expired token signs the user out. */
  accessToken(now = Date.now()): string | null {
    const token = this.token();
    if (token && token.expiresAt <= now) {
      void this.expire();
      return null;
    }
    return token?.accessToken ?? null;
  }

  async signIn(now = Date.now()): Promise<void> {
    if (!ANILIST.clientId) {
      this.message.set('Sign-in is not set up yet: the AniList client id is missing.');
      return;
    }
    this.message.set(null);
    this.status.set('signingIn');
    try {
      const state = crypto.randomUUID();
      await this.platform.writePending({ state, startedAt: now });
      await this.platform.openSignIn(authorizeUrl(state));
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

  /**
   * Handles `com.john.animewatchplanner://auth…`. Accepted only for a sign-in the user started on this
   * device in the last 15 minutes, and only with the same `state` when AniList sends one back, so a link
   * from a web page or another app cannot sign the user in to someone else's account.
   */
  async handleRedirect(url: string, now = Date.now()): Promise<void> {
    const result = parseAuthRedirect(url, now);
    if (!result) {
      return;
    }
    const pending = await this.platform.readPending().catch(() => null);
    const expected = pending && now - pending.startedAt <= SIGN_IN_WINDOW_MS ? pending.state : null;
    if (!expected || (result.state !== null && result.state !== expected)) {
      return;
    }
    await this.platform.deletePending().catch(() => undefined);
    await this.platform.closeSignIn();

    if (result.kind === 'error') {
      this.status.set('signedOut');
      this.message.set(`Sign-in did not finish: ${result.reason}`);
      return;
    }
    const token = { ...result.token, sessionId: crypto.randomUUID() };
    try {
      await this.platform.writeToken(token);
    } catch {
      this.status.set('signedOut');
      this.message.set('Could not save the sign-in on this device. Please try again.');
      return;
    }
    this.viewer.set(null);
    this.token.set(token);
    this.message.set(null);
    this.status.set('signedIn');
    await this.loadViewer();
  }

  /** Signs out on this device: forgets the token. ListService sees the status change and deletes the saved list. */
  async signOut(): Promise<void> {
    try {
      await this.platform.deleteToken();
    } finally {
      this.token.set(null);
      this.viewer.set(null);
      this.message.set(null);
      this.status.set('signedOut');
    }
  }

  /** Any AniList call that gets a 401 calls this: the user signs in again, with a clear message. */
  async expire(): Promise<void> {
    await this.signOut().catch(() => undefined);
    this.message.set('Your AniList session has ended. Please sign in again.');
  }

  /** Asks AniList who is signed in; the list refresh calls it again when the first try was offline. */
  async loadViewer(): Promise<void> {
    const token = this.token();
    if (!token) {
      return;
    }
    try {
      const viewer = await fetchViewer(token.accessToken, this.fetchFn);
      if (this.token() === token) this.viewer.set(viewer);
    } catch (error) {
      if (this.token() === token && error instanceof UnauthorizedError) {
        await this.expire();
      }
      // Offline or AniList down: stay signed in; the name shows up next time.
    }
  }
}
