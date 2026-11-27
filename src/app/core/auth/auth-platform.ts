import { Injectable } from '@angular/core';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

import type { PendingSignIn, StoredToken } from './auth-redirect';

const TOKEN_KEY = 'anilist.token';
const PENDING_KEY = 'anilist.pending';

/** Thin wrapper over the native plugins, so AuthService can be tested without a device. */
@Injectable({ providedIn: 'root' })
export class AuthPlatform {
  private accessSet = false;

  async openSignIn(url: string): Promise<void> {
    await Browser.open({ url, presentationStyle: 'popover' });
  }

  async closeSignIn(): Promise<void> {
    try {
      await Browser.close();
    } catch {
      // Android closes the Custom Tab by itself when the app comes back.
    }
  }

  async onRedirect(handler: (url: string) => void): Promise<void> {
    await App.addListener('appUrlOpen', ({ url }) => handler(url));
  }

  /** The URL that cold-started the app, e.g. the sign-in redirect after Android killed the app. */
  async launchUrl(): Promise<string | null> {
    return (await App.getLaunchUrl())?.url ?? null;
  }

  async onSignInClosed(handler: () => void): Promise<void> {
    await Browser.addListener('browserFinished', handler);
  }

  async readToken(): Promise<StoredToken | null> {
    const value = await SecureStorage.get(TOKEN_KEY, false, false);
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const { accessToken, expiresAt, sessionId } = value as Partial<StoredToken>;
      if (typeof accessToken === 'string' && typeof expiresAt === 'number') {
        return { accessToken, expiresAt, sessionId: typeof sessionId === 'string' ? sessionId : undefined };
      }
    }
    return null;
  }

  async writeToken(token: StoredToken): Promise<void> {
    await this.ensureAccess();
    await SecureStorage.set(TOKEN_KEY, { ...token }, false, false);
  }

  async deleteToken(): Promise<void> {
    await SecureStorage.remove(TOKEN_KEY, false);
  }

  /** Kept in secure storage, not memory, so it survives Android killing the app during sign-in. */
  async readPending(): Promise<PendingSignIn | null> {
    const value = await SecureStorage.get(PENDING_KEY, false, false);
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const { state, startedAt } = value as Partial<PendingSignIn>;
      if (typeof state === 'string' && typeof startedAt === 'number') {
        return { state, startedAt };
      }
    }
    return null;
  }

  async writePending(pending: PendingSignIn): Promise<void> {
    await this.ensureAccess();
    await SecureStorage.set(PENDING_KEY, { ...pending }, false, false);
  }

  async deletePending(): Promise<void> {
    await SecureStorage.remove(PENDING_KEY, false);
  }

  private async ensureAccess(): Promise<void> {
    if (!this.accessSet) {
      // iOS Keychain: readable only while the phone is unlocked, never synced or restored to another device.
      await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
      this.accessSet = true;
    }
  }
}
