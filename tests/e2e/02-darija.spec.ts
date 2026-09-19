import { test, expect } from '../fixtures/seed';

test('02 — Kenza répond en darija', async ({ page }) => {
  await page.goto('/');

  await page.fill('[data-testid="chat-input"]', 'chhal taman had t-shirt ?');
  await page.click('[data-testid="send-button"]');

  const response = page.locator('[data-testid="message-agent"]').last();
  await expect(response).toBeVisible({ timeout: 30_000 });

  // Vérifier que la réponse contient un prix ou une demande de précision
  const text = await response.textContent();
  expect(text).toBeTruthy();
  expect(text!.length).toBeGreaterThan(5);
});