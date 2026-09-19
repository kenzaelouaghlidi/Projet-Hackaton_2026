import { test as base } from '@playwright/test';

/**
 * Fixture : prépare l'environnement avant chaque test.
 * - Génère un client unique (évite les collisions de mémoire)
 * - Nettoie les conversations précédentes
 */
export const test = base.extend({
  clientId: async ({}, use, testInfo) => {
    const clientId = `test-${testInfo.testId}-${Date.now()}`;
    await use(clientId);
  },
});

export { expect } from '@playwright/test';