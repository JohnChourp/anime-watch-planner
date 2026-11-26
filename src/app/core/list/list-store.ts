import { Injectable } from '@angular/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

import { LIST_STATUSES, type ListEntry } from './anilist-list';

/** Bump when the saved shape changes: an old file is then ignored and the list is fetched again. */
export const CACHE_VERSION = 1;

export interface CachedList {
  version: number;
  /** The AniList user the list belongs to. */
  userId: number;
  /** Absent on older files, which need online owner verification before display. */
  sessionId?: string;
  /** Device time of the last full refresh, in ms (for the 30-day TTL). */
  fetchedAt: number;
  /** Device time of the last full refresh or check for changes, in ms (for "updated …" and the 15-minute gap). */
  checkedAt: number;
  /** Highest AniList `updatedAt` seen (server time, seconds): where the check for changes stops. */
  watermark: number;
  entries: ListEntry[];
}

const FILE = 'anilist-list.json';
const TEMP = 'anilist-list.json.tmp';
const STALE = 'anilist-list.stale';
/** App-private files with no cloud backup: iOS Library (excluded from iCloud), Android app files. */
const DIR = Directory.LibraryNoCloud;

/** The list cache as one JSON file on the device. A thin wrapper, so ListService can be tested without one. */
@Injectable({ providedIn: 'root' })
export class ListStore {
  needsRefresh = false;

  async read(): Promise<CachedList | null> {
    try {
      const { files } = await Filesystem.readdir({ path: '', directory: DIR });
      this.needsRefresh = files.some((file) => file.name === STALE);
      if (this.needsRefresh) return null;
      const file = await Filesystem.readFile({ path: FILE, directory: DIR, encoding: Encoding.UTF8 });
      const value = JSON.parse(String(file.data)) as Partial<CachedList>;
      const valid =
        value.version === CACHE_VERSION &&
        Number.isFinite(value.userId) &&
        Number.isFinite(value.fetchedAt) &&
        Number.isFinite(value.watermark) &&
        Array.isArray(value.entries) &&
        value.entries.every(validEntry);
      if (!valid) {
        return null;
      }
      // Files saved before task 3.2 have no checkedAt: their last check was the full refresh.
      const checkedAt = Number.isFinite(value.checkedAt) ? value.checkedAt : value.fetchedAt;
      return { ...value, checkedAt } as CachedList;
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
    if (this.needsRefresh) {
      const { files } = await Filesystem.readdir({ path: '', directory: DIR });
      if (files.some((file) => file.name === STALE)) await Filesystem.deleteFile({ path: STALE, directory: DIR });
      this.needsRefresh = false;
    }
  }

  /** A confirmed edit missed the offline file. Never restore that file as fresh on the next launch. */
  async invalidate(): Promise<void> {
    this.needsRefresh = true;
    try {
      await Filesystem.writeFile({ path: STALE, directory: DIR, data: '1', encoding: Encoding.UTF8 });
    } catch {
      // Even a tiny marker can fail on a full disk. Discard the old file in that case.
      await Filesystem.deleteFile({ path: FILE, directory: DIR }).catch(() => undefined);
    }
  }

  /** Deletes only the files that are there, so a signed-out start does not log "file does not exist" errors. */
  async delete(): Promise<void> {
    const names = await Filesystem.readdir({ path: '', directory: DIR })
      .then((result) => result.files.map((f) => f.name))
      .catch(() => [FILE, TEMP, STALE]);
    for (const path of [FILE, TEMP, STALE].filter((name) => names.includes(name))) {
      await Filesystem.deleteFile({ path, directory: DIR }).catch(() => undefined);
    }
    this.needsRefresh = false;
  }
}

/** Validate fields used by the editor before exposing rows from a locally stored JSON file. */
function validEntry(entry: ListEntry | null): boolean {
  const media = entry?.media;
  const title = media?.title;
  return (
    !!entry &&
    Number.isSafeInteger(entry.id) &&
    entry.id > 0 &&
    LIST_STATUSES.includes(entry.status) &&
    [entry.progress, entry.repeat, entry.score, entry.updatedAt].every(Number.isFinite) &&
    !!media &&
    Number.isSafeInteger(media.id) &&
    media.id > 0 &&
    !!title &&
    typeof title === 'object' &&
    !Array.isArray(title) &&
    (title.english === null || typeof title.english === 'string') &&
    (title.romaji === null || typeof title.romaji === 'string') &&
    (media.format == null || typeof media.format === 'string') &&
    (media.seasonYear == null || Number.isSafeInteger(media.seasonYear))
  );
}
