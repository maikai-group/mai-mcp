import { test, expect } from '@playwright/test';

// A DEDICATED spec file, not a describe block: Playwright refuses
// test.use({ launchOptions }) inside a describe ("it forces a new worker"), and
// the flag must NOT be global — --use-angle=swiftshader changes compositing
// enough to break the pre-existing @dnd-kit roadmap drag test in smoke.spec.ts
// (proven: that test passes without the flag and fails with it). Plan 29 A14.
test.use({ launchOptions: { args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] } });

test.beforeEach(async ({ page, request }) => {
  // Same server-side settings baseline as smoke.spec.ts (plan 29 A17):
  // graph.theme is shared state in operator_settings, so each spec resets it.
  const reset = await request.post('/api/settings', { data: { key: 'graph.theme', value: 'organism' } });
  expect(reset.ok()).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('mai-project', 'e2e-dash'));
});

test('2D↔3D preserves a real selection and applies a live 3D theme change', async ({ page }) => {
  await page.goto('/#/graph');
  const root = page.locator('[data-graph-status]');
  await expect(root).toHaveAttribute('data-graph-status', 'ready', { timeout: 15_000 });
  const before = await root.getAttribute('data-node-count');

  // Drive the real Spotlight contract: '/' opens, a typed result is clicked,
  // and the renderer-independent observable must hold the chosen id.
  await page.keyboard.press('/');
  await page.getByPlaceholder('search the graph…').fill('hub_b');
  await page.getByRole('button', { name: /hub_b\s+function/ }).click();
  await expect(root).not.toHaveAttribute('data-selected', '');
  const selected = await root.getAttribute('data-selected');
  expect(selected).toBeTruthy();

  const toggle = page.locator('[data-view-toggle]');
  await expect(toggle).toHaveAttribute('data-webgl', 'ok');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(root).toHaveAttribute('data-view', '3d');
  await expect(page.locator('[data-webgl="ok"]')).toBeVisible();
  expect(await root.getAttribute('data-node-count')).toBe(before);
  await expect(page.locator('[data-3d-selected]')).toHaveAttribute('data-3d-selected', selected ?? '');

  // Change theme while the real 3D surface is live, not before mounting it.
  // Choose a value different from whatever this isolated run inherited. Tests
  // must not depend on Playwright order or on the operator_settings seed.
  const themeSelect = page.getByLabel('graph theme', { exact: true });
  const beforeTheme = await themeSelect.inputValue();
  const nextTheme = beforeTheme === 'signal' ? 'atlas' : 'signal';
  await themeSelect.selectOption(nextTheme);
  await expect(page.locator('[data-3d-theme]')).toHaveAttribute('data-3d-theme', nextTheme);
  await expect(root).toHaveAttribute('data-selected', selected ?? '');

  await toggle.click();
  await expect(root).toHaveAttribute('data-view', '2d');
  expect(await root.getAttribute('data-node-count')).toBe(before);
  await expect(root).toHaveAttribute('data-selected', selected ?? '');
});
