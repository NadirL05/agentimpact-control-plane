import { expect, test } from '@playwright/test';

// Scénario E2E du parcours principal (docs/TESTING.md, T7 ; docs/APP_FLOW.md).
const PASSWORD = process.env.E2E_PASSWORD || 'e2e-mot-de-passe-de-test-32-caracteres';

test('connexion, onglet Missions, à relire, bloquées, toutes, mobile', async ({ page }) => {
  // 1. Sans session : redirection vers la connexion.
  await page.goto('/dashboard/');
  await expect(page).toHaveURL(/\/dashboard\/login\.html$/);

  // 2. Mauvais mot de passe : message d'erreur, on reste sur la page.
  await page.getByLabel('Mot de passe').fill('mauvais');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.locator('#error')).toHaveText('Identifiants invalides.');

  // 3. Bon mot de passe : accueil.
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);

  // 4. Onglet Missions, filtre « À relire » par défaut : seule la PR encore ouverte.
  await page.getByRole('tab', { name: 'Missions' }).click();
  const rows = page.locator('details.mission');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('AGE-9001');
  await expect(rows.first().getByRole('link', { name: 'Ouvrir la PR' })).toHaveAttribute('href', 'https://github.com/NadirL05/demo/pull/1');
  await expect(page.locator('#home-panel')).toBeHidden();

  // 5. « Bloquées » : la raison en une phrase et l'action conseillée.
  await page.getByRole('button', { name: /Bloquées/ }).click();
  await expect(rows).toHaveCount(1);
  await rows.first().locator('summary').click();
  await expect(rows.first()).toContainText('Un contrôle qui passait avant la mission échoue maintenant (test).');
  await expect(rows.first()).toContainText('À faire :');

  // 6. « Toutes » : 4 lignes, durées et coût, jamais « None ».
  await page.getByRole('button', { name: /Toutes/ }).click();
  await expect(rows).toHaveCount(4);
  await expect(page.locator('#missions-week')).toContainText('4');
  await expect(page.locator('#missions-panel')).not.toContainText('None');
  await expect(page.locator('#missions-panel')).not.toContainText('undefined');

  // 7. Mobile 375 px : pas de défilement horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  expect(overflow).toBeLessThanOrEqual(0);
});

test('ouverture directe par #missions et aucun script bloqué par la CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await page.goto('/dashboard/login.html');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto('/dashboard/#missions');
  await expect(page.locator('#missions-panel')).toBeVisible();
  await expect(page.locator('details.mission')).toHaveCount(1);
  expect(violations).toEqual([]);
});
