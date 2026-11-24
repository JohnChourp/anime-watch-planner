import { Injectable } from '@angular/core';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

import type { StoredToken } from './auth-redirect';

const TOKEN_KEY = 'anilist.token';

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

  async onSignInClosed(handler: () => void): Promise<void> {
    await Browser.addListener('browserFinished', handler);
  }

  async readToken(): Promise<StoredToken | null> {
    const value = await SecureStorage.get(TOKEN_KEY, false, false);
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const { accessToken, expiresAt } = value as Partial<StoredToken>;
      if (typeof accessToken === 'string' && typeof expiresAt === 'number') {
        return { accessToken, expiresAt };
      }
    }
    return null;
  }

  async writeToken(token: StoredToken): Promise<void> {
    if (!this.accessSet) {
      // iOS Keychain: readable only while the phone is unlocked, never synced or restored to another device.
      await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
      this.accessSet = true;
    }
    await SecureStorage.set(TOKEN_KEY, { ...token }, false, false);
  }

  async deleteToken(): Promise<void> {
    await SecureStorage.remove(TOKEN_KEY, false);
  }
}
