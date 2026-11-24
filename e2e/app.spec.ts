import { expect, test } from '@playwright/test';

test('visits the app root url', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.empty-state')).toContainText('Your AniList list will live here');
});
