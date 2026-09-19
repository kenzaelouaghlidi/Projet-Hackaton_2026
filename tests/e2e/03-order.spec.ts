import { test, expect } from '../fixtures/seed';

test('03 — Le client valide une commande', async ({ page }) => {
  await page.goto('/');

  // Étape 1 : demander un prix
  await page.fill('[data-testid="chat-input"]', 'chhal taman t-shirt zreq ?');
  await page.click('[data-testid="send-button"]');

  await expect(page.locator('[data-testid="message-agent"]').last()).toBeVisible({ timeout: 30_000 });

  // Étape 2 : valider la commande
  await page.fill('[data-testid="chat-input"]', 'wa ncommandi');
  await page.click('[data-testid="send-button"]');

  await expect(page.locator('[data-testid="message-agent"]').last()).toBeVisible({ timeout: 30_000 });

  // Étape 3 : vérifier le dashboard
  await page.click('[data-testid="tab-dashboard"]');
  await expect(page.locator('[data-testid="orders-count"]')).not.toHaveText('0');
});