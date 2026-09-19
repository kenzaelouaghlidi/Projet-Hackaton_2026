import { test, expect } from '../fixtures/seed';

test('06 — Question hors domaine : escalade au commerçant', async ({ page }) => {
  await page.goto('/');

  await page.fill('[data-testid="chat-input"]', 'bghit facture b smiya dyal société');
  await page.click('[data-testid="send-button"]');

  // Attendre la réponse
  await expect(page.locator('[data-testid="message-agent"]').last()).toBeVisible({ timeout: 30_000 });

  // Vérifier l'escalade dans le dashboard
  await page.click('[data-testid="tab-dashboard"]');
  await page.click('[data-testid="tab-escalations"]');
  await expect(page.locator('[data-testid="escalations-count"]')).not.toHaveText('0');
});