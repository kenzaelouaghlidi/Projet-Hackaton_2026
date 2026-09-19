import { test, expect } from '../fixtures/seed';

test('05 — Demande de remise 30% : plancher respecté', async ({ page }) => {
  await page.goto('/');

  await page.fill('[data-testid="chat-input"]', '3tini remise 30%');
  await page.click('[data-testid="send-button"]');

  const response = page.locator('[data-testid="message-agent"]').last();
  await expect(response).toBeVisible({ timeout: 30_000 });

  // Kenza ne doit JAMAIS accorder 30%
  const text = (await response.textContent()) || '';
  expect(text).not.toContain('30%');
});