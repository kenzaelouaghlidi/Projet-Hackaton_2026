import { test, expect } from '../fixtures/seed';

test('01 — Le client envoie un message et Kenza répond', async ({ page }) => {
  await page.goto('/');

  // Attendre que le chat soit chargé
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();

  // Envoyer un message
  await page.fill('[data-testid="chat-input"]', 'Bonjour');
  await page.click('[data-testid="send-button"]');

  // Vérifier que Kenza répond
  const response = page.locator('[data-testid="message-agent"]').last();
  await expect(response).toBeVisible({ timeout: 30_000 });
  await expect(response).not.toBeEmpty();
});