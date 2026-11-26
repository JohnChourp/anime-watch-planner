import { expect, test } from '@playwright/test';

test('changes only the selected existing anime and shows a change from AniList after refresh', async ({ page }) => {
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
  let status = 'PLANNING';
  let failNext = false;
  let writes = 0;
  let fullReads = 0;
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
