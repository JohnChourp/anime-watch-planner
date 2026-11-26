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

  beforeEach(() => {
    vi.clearAllMocks();
    fs.readdir.mockResolvedValue({ files: [] });
    fs.deleteFile.mockResolvedValue();
  });

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

  const row = {
    id: 4,
    status: 'CURRENT',
    progress: 1,
    repeat: 0,
    score: 0,
    updatedAt: 100,
    media: { id: 11, title: { romaji: 'Demo', english: null } },
  };
  it.each([
    null,
    { ...row, id: '4' },
    { ...row, media: { id: 11 } },
    { ...row, status: null },
    { ...row, media: { ...row.media, format: {} } },
    { ...row, media: { ...row.media, title: { romaji: {}, english: null } } },
  ])('discards the entire file when an editor row is malformed', async (bad) => {
    fs.readFile.mockResolvedValue({ data: JSON.stringify({ ...good, entries: [row, bad] }) });
    expect(await store.read()).toBeNull();
  });

  it('accepts legacy rows with nullable title fields and no dates or session identifier', async () => {
    const legacy = { ...good, entries: [row] };
    fs.readFile.mockResolvedValue({ data: JSON.stringify(legacy) });
    expect(await store.read()).toEqual(legacy);
  });

  it('withholds an invalidated file across instances until the complete replacement is renamed', async () => {
    fs.writeFile.mockResolvedValue({ uri: '' });
    await store.invalidate();
    expect(fs.writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'anilist-list.stale' }));
    fs.readdir.mockResolvedValue({ files: [{ name: 'anilist-list.stale' }] } as never);
    const restarted = new ListStore();
    expect(await restarted.read()).toBeNull();
    expect(restarted.needsRefresh).toBe(true);
    fs.rename.mockRejectedValueOnce(new Error('disk full'));
    await expect(restarted.write(good)).rejects.toThrow();
    expect(fs.deleteFile).not.toHaveBeenCalled();
    fs.rename.mockResolvedValue();
    await restarted.write(good);
    expect(fs.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'anilist-list.stale' }));
    expect(restarted.needsRefresh).toBe(false);
  });

  it('discards the stale file if the device cannot store even a marker', async () => {
    fs.writeFile.mockRejectedValueOnce(new Error('no space for a marker'));
    await new ListStore().invalidate();
    expect(fs.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'anilist-list.json' }));
  });

  it('reports a successful write only after the temporary file has its final offline name', async () => {
    let finishRename!: () => void;
    fs.rename.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRename = resolve)));
    const completed = vi.fn();
    const writing = store.write(good).then(completed);
    await vi.waitFor(() => expect(fs.rename).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    finishRename();
    await writing;
    expect(completed).toHaveBeenCalledOnce();
  });

  it('deletes only the files that are there', async () => {
    fs.readdir.mockResolvedValue({ files: [{ name: 'anilist-list.json' }] } as never);
    fs.deleteFile.mockResolvedValue();
    await store.delete();
    expect(fs.deleteFile).toHaveBeenCalledTimes(1);
    expect(fs.deleteFile).toHaveBeenCalledWith({ path: 'anilist-list.json', directory: 'LIBRARY_NO_CLOUD' });
  });

  it('tries the cache, temporary file and stale marker when the folder cannot be listed', async () => {
    fs.readdir.mockRejectedValue(new Error('no folder'));
    fs.deleteFile.mockRejectedValue(new Error('missing'));
    await store.delete();
    expect(fs.deleteFile).toHaveBeenCalledTimes(3);
  });
});
