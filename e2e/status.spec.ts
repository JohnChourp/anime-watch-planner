import { Directory, Encoding, type FilesystemPlugin } from '@capacitor/filesystem';
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    Capacitor: { Plugins: { Filesystem: FilesystemPlugin } };
  }
}

function readOfflineList(page: Page) {
  return page.evaluate(
    async (options) => {
      const file = await window.Capacitor.Plugins.Filesystem.readFile(options).catch(() => null);
      return file ? JSON.parse(String(file.data)) : null;
    },
    { path: 'anilist-list.json', directory: Directory.LibraryNoCloud, encoding: Encoding.UTF8 },
  );
}

async function simulateFullDisk(page: Page) {
  // Fail only writes to the list file in this browser. Reads still see the real offline copy.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (value?.path?.endsWith('/anilist-list.json.tmp') && sessionStorage.getItem('disk-full')) {
        throw new DOMException('Disk full', 'QuotaExceededError');
      }
      return put.call(this, value, key);
    };
    sessionStorage.setItem('disk-full', '1');
  });
}

test.beforeEach(async ({ page }) => {
  // Restore the session through the web storage adapter in this isolated browser context.
  await page.addInitScript(() =>
    localStorage.setItem(
      'capacitor-storage_anilist.token',
      JSON.stringify({
        accessToken: 'local-test-session',
        expiresAt: Date.now() + 3600_000,
      }),
    ),
  );
});

const entry = (id: number, title: string, state: string) => ({
  id,
  status: state,
  progress: 2,
  score: 0,
  repeat: 0,
  updatedAt: 100,
  startedAt: null,
  completedAt: null,
  media: { id: id + 100, title: { romaji: title, english: null }, coverImage: null },
});
test('changes only the selected existing anime and shows a change from AniList after refresh', async ({ page }) => {
  let status = 'PLANNING';
  let failNext = false;
  let writes = 0;
  let fullReads = 0;
  await page.route('https://graphql.anilist.co/**', async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (query.includes('Viewer')) return route.fulfill({ json: { data: { Viewer: { id: 5, name: 'Demo' } } } });
    if (query.includes('MediaListCollection')) {
      fullReads++;
      return route.fulfill({
        json: {
          data: {
            MediaListCollection: {
              hasNextChunk: false,
              lists: [{ entries: [entry(11, 'First title', 'COMPLETED'), entry(22, 'Second title', status)] }],
            },
          },
        },
      });
    }
    expect(query).toContain('SaveMediaListEntry');
    expect(variables.id).toBe(22);
    expect(Object.keys(variables).sort()).toEqual(['id', 'status']);
    writes++;
    if (failNext) return route.fulfill({ status: 503, json: { errors: [{ message: 'Unavailable' }] } });
    status = variables.status;
    return route.fulfill({ json: { data: { SaveMediaListEntry: entry(22, 'Second title', status) } } });
  });
  await page.goto('/');
  await page.getByLabel('Anime in your list').selectOption({ label: 'Second title' });
  const statusButton = (name: string) => page.getByRole('button', { name, exact: true });
  await expect(statusButton('Planning')).toHaveAttribute('aria-pressed', 'true');
  await statusButton('Watching').click();
  await expect(page.getByText('Saved to AniList.')).toBeVisible();
  await expect(statusButton('Watching')).toHaveAttribute('aria-pressed', 'true');
  expect({ writes, fullReads }).toEqual({ writes: 1, fullReads: 1 });
  failNext = true;
  await statusButton('Dropped').click();
  await expect(page.getByText(/Could not confirm/)).toBeVisible();
  await expect(statusButton('Watching')).toHaveAttribute('aria-pressed', 'true');
  status = 'PAUSED';
  await page.locator('ion-refresher').dispatchEvent('ionRefresh');
  await expect(statusButton('Paused')).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Anime in your list').selectOption({ label: 'First title' });
  await expect(statusButton('Completed')).toHaveAttribute('aria-pressed', 'true');
  expect({ writes, fullReads }).toEqual({ writes: 2, fullReads: 2 });
});

test('distinguishes namesakes and keeps a delayed failure attached to its anime after switching titles', async ({
  page,
}) => {
  const rows = [
    [11, 1999, 'TV'],
    [22, 2020, 'MOVIE'],
    [33, 2020, 'MOVIE'],
    [44, null, null],
  ] as const;
  const entries = rows.map(([id, year, format]) => {
    const row = entry(id, 'Twin', 'CURRENT');
    return {
      ...row,
      media: {
        ...row.media,
        title: { english: id === 11 ? 'Twin' : null, romaji: id === 11 ? 'Other name' : 'Twin' },
        seasonYear: year,
        format,
      },
    };
  });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => (release = resolve));
  const writes: number[] = [];
  await page.route('https://graphql.anilist.co/**', async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (query.includes('Viewer')) return route.fulfill({ json: { data: { Viewer: { id: 5, name: 'Demo' } } } });
    if (query.includes('MediaListCollection')) {
      return route.fulfill({
        json: { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries }] } } },
      });
    }
    expect(query).toContain('SaveMediaListEntry');
    writes.push(variables.id);
    await delayed;
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/');
  const picker = page.getByLabel('Anime in your list');
  const labels = [
    'Choose a title',
    'Twin (1999, TV)',
    'Twin (2020, Movie) #122',
    'Twin (2020, Movie) #133',
    'Twin #144',
  ];
  await expect(picker.locator('option')).toHaveText(labels);
  await picker.selectOption({ label: labels[2] });
  await page.getByRole('button', { name: 'Paused', exact: true }).click();
  await expect.poll(() => writes).toEqual([22]);
  await picker.selectOption({ label: labels[1] });
  release();
  const failure = page.getByRole('alert').filter({ hasText: 'Could not confirm' });
  await expect(failure).toHaveText(/^Twin \(2020, Movie\) #122.*Could not confirm/);
  await expect(page.getByRole('button', { name: 'Watching', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await picker.selectOption({ label: labels[2] });
  await expect(page.getByText(/Could not confirm/)).toHaveCount(1);
  await picker.selectOption('');
  await expect(failure).toBeVisible();
  await picker.selectOption('11');
  await page.getByRole('button', { name: 'Dropped', exact: true }).click();
  await expect(failure).toHaveCount(2);
  await expect(failure.filter({ hasText: labels[1] })).toBeVisible();
  await expect(failure.filter({ hasText: labels[2] })).toBeVisible();
});

test('explains how to enable editing after an offline start and enables it on pull-to-refresh', async ({ page }) => {
  let online = true;
  let viewerReads = 0;
  await page.route('https://graphql.anilist.co/**', async (route) => {
    const { query } = route.request().postDataJSON();
    if (query.includes('Viewer')) {
      viewerReads++;
      if (!online) return route.abort('internetdisconnected');
      return route.fulfill({ json: { data: { Viewer: { id: 5, name: 'Demo' } } } });
    }
    expect(query).toContain('MediaListCollection');
    return route.fulfill({
      json: {
        data: {
          MediaListCollection: { hasNextChunk: false, lists: [{ entries: [entry(11, 'First title', 'CURRENT')] }] },
        },
      },
    });
  });
  await page.goto('/');
  const picker = page.getByLabel('Anime in your list');
  await picker.selectOption('11');
  await expect(page.getByRole('button', { name: 'Paused' })).toBeEnabled();
  // Rendering precedes the final file rename. Read the same offline file the next launch will open.
  await expect.poll(() => readOfflineList(page)).toMatchObject({ userId: 5, entries: [{ id: 11, status: 'CURRENT' }] });
  online = false;
  await page.reload();
  await picker.selectOption('11');
  const hint = page.getByText(/Reconnect.*pull down to refresh/i);
  await expect(hint).toBeVisible();
  await expect(page.locator('fieldset button:disabled')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Watching', exact: true })).toHaveAttribute('aria-pressed', 'true');
  online = true;
  const readsBeforeRefresh = viewerReads;
  await page.locator('ion-refresher').dispatchEvent('ionRefresh');
  await expect(page.getByRole('button', { name: 'Paused' })).toBeEnabled();
  expect(viewerReads).toBe(readsBeforeRefresh + 1);
  await expect(hint).toHaveCount(0);
});

test('shows the offline warning when a refresh confirms the selected status before dispatch', async ({ page }) => {
  let reads = 0;
  let writes = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('https://graphql.anilist.co/**', async (route) => {
    const { query } = route.request().postDataJSON();
    if (query.includes('Viewer')) return route.fulfill({ json: { data: { Viewer: { id: 5, name: 'Demo' } } } });
    if (!query.includes('MediaListCollection')) {
      writes++;
      return route.fulfill({ status: 503, json: {} });
    }
    reads++;
    if (reads === 2) await held;
    const row = entry(11, 'First title', reads === 1 ? 'CURRENT' : 'PAUSED');
    return route.fulfill({
      json: { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries: [row] }] } } },
    });
  });
  await page.goto('/');
  await page.getByLabel('Anime in your list').selectOption('11');
  await expect.poll(() => readOfflineList(page)).toMatchObject({ entries: [{ status: 'CURRENT' }] });
  await simulateFullDisk(page);
  await page.locator('ion-refresher').dispatchEvent('ionRefresh');
  await expect.poll(() => reads).toBe(2);
  const paused = page.getByRole('button', { name: 'Paused', exact: true });
  await paused.click();
  release();
  const warning = page.getByRole('alert').filter({ hasText: 'offline copy on this device' });
  await expect(warning).toContainText('First title');
  await expect(paused).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Saved to AniList.', { exact: true })).toBeVisible();
  expect(await readOfflineList(page)).toMatchObject({ entries: [{ status: 'CURRENT' }] });
  await page.evaluate(() => sessionStorage.removeItem('disk-full'));
  await page.locator('ion-refresher').dispatchEvent('ionRefresh');
  await expect.poll(() => readOfflineList(page)).toMatchObject({ entries: [{ status: 'PAUSED' }] });
  await expect(warning).toHaveCount(0);
  expect(writes).toBe(0);
});

test('keeps a title-specific storage warning until the offline list is actually repaired', async ({ page }) => {
  const rows = [entry(11, 'First title', 'CURRENT'), entry(22, 'Second title', 'CURRENT')];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const writes: number[] = [];
  await page.route('https://graphql.anilist.co/**', async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (query.includes('Viewer')) return route.fulfill({ json: { data: { Viewer: { id: 5, name: 'Demo' } } } });
    if (query.includes('MediaListCollection'))
      return route.fulfill({
        json: { data: { MediaListCollection: { hasNextChunk: false, lists: [{ entries: rows }] } } },
      });
    expect(query).toContain('SaveMediaListEntry');
    writes.push(variables.id);
    await held;
    if (variables.status === 'DROPPED') return route.fulfill({ status: 503, json: {} });
    const row = rows.find((item) => item.id === variables.id)!;
    row.status = variables.status;
    return route.fulfill({ json: { data: { SaveMediaListEntry: row } } });
  });
  await page.goto('/');
  const picker = page.getByLabel('Anime in your list');
  await picker.selectOption('11');
  await expect
    .poll(() => readOfflineList(page))
    .toMatchObject({
      entries: [
        { id: 11, status: 'CURRENT' },
        { id: 22, status: 'CURRENT' },
      ],
    });
  await simulateFullDisk(page);
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  await button('Paused').click();
  await expect.poll(() => writes).toEqual([11]);
  await button('Dropped').click();
  await button('Paused').click();
  await picker.selectOption('22');
  release();
  const warning = page.getByRole('alert').filter({ hasText: 'offline copy on this device' });
  await expect(warning).toContainText('First title');
  await picker.selectOption('11');
  await expect(page.getByText('Saved to AniList.', { exact: true })).toBeVisible();
  await button('Dropped').click();
  const remoteError = page.getByRole('alert').filter({ hasText: 'Could not confirm' });
  await expect(remoteError).toContainText('First title');
  await expect(warning).toBeVisible();
  await expect(page.getByText('Saved to AniList.', { exact: false })).toHaveCount(0);
  await expect(button('Paused')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => readOfflineList(page))
    .toMatchObject({ entries: [{ status: 'CURRENT' }, { status: 'CURRENT' }] });
  await page.evaluate(() => sessionStorage.removeItem('disk-full'));
  await picker.selectOption('22');
  await button('Completed').click();
  await expect(button('Completed')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => readOfflineList(page))
    .toMatchObject({ entries: [{ status: 'PAUSED' }, { status: 'COMPLETED' }] });
  await expect(warning).toHaveCount(0);
  await expect(remoteError).toContainText('First title');
  expect(writes).toEqual([11, 11, 22]);
});
