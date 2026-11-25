import { Filesystem } from '@capacitor/filesystem';

import { CACHE_VERSION, ListStore, type CachedList } from './list-store';

vi.mock('@capacitor/filesystem', () => ({
  Directory: { LibraryNoCloud: 'LIBRARY_NO_CLOUD' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    readdir: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

const fs = vi.mocked(Filesystem);
const good: CachedList = { version: CACHE_VERSION, userId: 7, fetchedAt: 1, checkedAt: 3, watermark: 2, entries: [] };

describe('ListStore', () => {
  const store = new ListStore();

  beforeEach(() => vi.clearAllMocks());

  it('reads a saved list', async () => {
    fs.readFile.mockResolvedValue({ data: JSON.stringify(good) });
    expect(await store.read()).toEqual(good);
  });

  it('reads a file saved before checkedAt existed as last checked at its full refresh', async () => {
    const { checkedAt: _, ...old } = good;
    fs.readFile.mockResolvedValue({ data: JSON.stringify(old) });
    expect(await store.read()).toEqual({ ...good, checkedAt: 1 });
  });

  it('ignores a missing, damaged, older or incomplete file', async () => {
    fs.readFile.mockRejectedValueOnce(new Error('missing'));
    expect(await store.read()).toBeNull();
    for (const data of [
      '{not json',
      JSON.stringify({ ...good, version: 0 }),
      JSON.stringify({ ...good, fetchedAt: null }),
    ]) {
      fs.readFile.mockResolvedValueOnce({ data });
      expect(await store.read()).toBeNull();
    }
  });

  it('writes a temporary file first and then renames it, in the no-backup folder', async () => {
    await store.write(good);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'anilist-list.json.tmp', directory: 'LIBRARY_NO_CLOUD', recursive: true }),
    );
    expect(fs.rename).toHaveBeenCalledWith({
      from: 'anilist-list.json.tmp',
      to: 'anilist-list.json',
      directory: 'LIBRARY_NO_CLOUD',
      toDirectory: 'LIBRARY_NO_CLOUD',
    });
    expect(fs.writeFile.mock.invocationCallOrder[0]).toBeLessThan(fs.rename.mock.invocationCallOrder[0]);
  });

  it('deletes only the files that are there', async () => {
    fs.readdir.mockResolvedValue({ files: [{ name: 'anilist-list.json' }] } as never);
    fs.deleteFile.mockResolvedValue();
    await store.delete();
    expect(fs.deleteFile).toHaveBeenCalledTimes(1);
    expect(fs.deleteFile).toHaveBeenCalledWith({ path: 'anilist-list.json', directory: 'LIBRARY_NO_CLOUD' });
  });

  it('tries both files when the folder cannot be listed', async () => {
    fs.readdir.mockRejectedValue(new Error('no folder'));
    fs.deleteFile.mockRejectedValue(new Error('missing'));
    await store.delete();
    expect(fs.deleteFile).toHaveBeenCalledTimes(2);
  });
});
