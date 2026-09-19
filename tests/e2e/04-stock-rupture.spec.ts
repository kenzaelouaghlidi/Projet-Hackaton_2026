import { test, expect } from '../fixtures/seed';

test('04 — Rupture de stock : Kenza propose une alternative', async ({ page }) => {
  await page.goto('/');

  await page.fill('[data-testid="chat-input"]', 'bghit t-shirt khal');
  await page.click('[data-testid="send-button"]');

  const response = page.locator('[data-testid="message-agent"]').last();
  await expect(response).toBeVisible({ timeout: 30_000 });

  // Vérifier que Kenza ne promet PAS un délai
  const text = (await response.textContent()) || '';
  expect(text).not.toMatch(/dans \d+ jours/i);
  expect(text).not.toMatch(/\d+ jours/i);
});