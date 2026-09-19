import { test, expect } from '../fixtures/seed';

test('07 — Le dashboard affiche conversations, ventes, escalades', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-testid="tab-dashboard"]');

  // Vérifier les 3 sections
  await expect(page.locator('[data-testid="conversations-count"]')).toBeVisible();
  await expect(page.locator('[data-testid="orders-count"]')).toBeVisible();
  await expect(page.locator('[data-testid="escalations-count"]')).toBeVisible();
});