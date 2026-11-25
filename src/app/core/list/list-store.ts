import { Injectable } from '@angular/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

import type { ListEntry } from './anilist-list';

/** Bump when the saved shape changes: an old file is then ignored and the list is fetched again. */
export const CACHE_VERSION = 1;

export interface CachedList {
  version: number;
  /** The AniList user the list belongs to. */
  userId: number;
  /** Device time of the last full refresh, in ms (for the 30-day TTL). */
  fetchedAt: number;
  /** Highest AniList `updatedAt` seen (server time, seconds): where "changes only" (3.2) will stop. */
  watermark: number;
  entries: ListEntry[];
}

const FILE = 'anilist-list.json';
const TEMP = 'anilist-list.json.tmp';
/** App-private files with no cloud backup: iOS Library (excluded from iCloud), Android app files. */
const DIR = Directory.LibraryNoCloud;

/** The list cache as one JSON file on the device. A thin wrapper, so ListService can be tested without one. */
@Injectable({ providedIn: 'root' })
export class ListStore {
  async read(): Promise<CachedList | null> {
    try {
      const file = await Filesystem.readFile({ path: FILE, directory: DIR, encoding: Encoding.UTF8 });
      const value = JSON.parse(String(file.data)) as Partial<CachedList>;
      return value.version === CACHE_VERSION && Array.isArray(value.entries) ? (value as CachedList) : null;
    } catch {
      return null; // No file yet, or a damaged one: fetch again.
    }
  }

  /** Writes a temporary file, then renames it, so a crash mid-write never leaves half a list. */
  async write(list: CachedList): Promise<void> {
    await Filesystem.writeFile({
      path: TEMP,
      directory: DIR,
      encoding: Encoding.UTF8,
      data: JSON.stringify(list),
      recursive: true,
    });
    await Filesystem.rename({ from: TEMP, to: FILE, directory: DIR, toDirectory: DIR });
  }

  async delete(): Promise<void> {
    for (const path of [FILE, TEMP]) {
      await Filesystem.deleteFile({ path, directory: DIR }).catch(() => undefined);
    }
  }
}
