import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { IdeaRow } from '../src/lib/types.js';

const p42Prefix = 'E2E P42 ';

async function ideaColumnTitles(page: Page): Promise<string[]> {
  return page.getByTestId('column-idea').getByTestId('idea-card').evaluateAll((cards) =>
    cards.map((card) => card.querySelector('p')?.firstChild?.textContent?.trim() ?? '')
  );
}

async function p42ColumnTitles(page: Page): Promise<string[]> {
  return (await ideaColumnTitles(page)).filter((title) => title.startsWith(p42Prefix));
}

async function roadmapRows(request: APIRequestContext): Promise<IdeaRow[]> {
  const response = await request.get('/api/ideas?scope=both&closed=1&project=e2e-dash');
  if (!response.ok()) throw new Error(`roadmap API failed: ${await response.text()}`);
  const payload: { rows: IdeaRow[] } = await response.json();
  return payload.rows;
}

async function dragCardOver(page: Page, movingTitle: string, targetTitle: string): Promise<void> {
  const moving = page.getByTestId('idea-card').filter({ hasText: movingTitle });
  const target = page.getByTestId('idea-card').filter({ hasText: targetTitle });
  const from = await moving.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('priority-band drag card has no bounding box');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
}

// Pin the fixture project before app JS runs (the client reads it from
// localStorage). Runs on every navigation in the test.
test.beforeEach(async ({ page, request }, testInfo) => {
  // graph.theme lives in server-side operator_settings (plan 30), so it is
  // shared state across specs: without this reset a theme-switching test leaks
  // into every later one. Establish the documented default through the real
  // settings API and await it before any navigation (plan 29 A17).
  const reset = await request.post('/api/settings', { data: { key: 'graph.theme', value: 'organism' } });
  expect(reset.ok()).toBeTruthy();
  if (testInfo.title === 'async-default project keeps promotion current and reset returns to landing') return;
  await page.addInitScript(() => localStorage.setItem('mai-project', 'e2e-dash'));
});

test('every destination renders its heading', async ({ page }) => {
  const cases: Array<[string, string]> = [
    ['home', 'the riverbed'],
    ['review', 'Review'],
    ['search', 'Search'],
    ['timeline', 'Timeline'],
    ['sessions', 'Sessions'],
    ['topics', 'Topics'],
  ];
  for (const [hash, heading] of cases) {
    await page.goto(`/#/${hash}`);
    await expect(page.getByText(heading, { exact: false }).first()).toBeVisible();
  }
});

test('graph landing renders modules and >= 5 nodes', async ({ page }) => {
  await page.goto('/#/graph');
  const root = page.locator('[data-graph-status]');
  await expect(root).toHaveAttribute('data-graph-status', 'ready', { timeout: 15_000 });
  const count = Number(await root.getAttribute('data-node-count'));
  expect(count).toBeGreaterThanOrEqual(5);
});

test('roadmap renders the four columns and the seeded cards', async ({ page }) => {
  await page.goto('/#/roadmap');
  for (const status of ['idea', 'planned', 'building', 'shipped']) {
    await expect(page.getByRole('heading', { name: status, exact: true })).toBeVisible();
  }
  for (const title of ['E2E parked idea', 'E2E planned item', 'E2E building item']) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
});

test('roadmap priority bands, priority changes, and manual order survive reloads', async ({ page, request }) => {
  const initial = [
    'E2E P42 project now beta',
    'E2E P42 project now alpha',
    'E2E P42 global now overlap',
    'E2E P42 project next alpha',
    'E2E P42 project next beta',
    'E2E P42 project later beta',
    'E2E P42 project later alpha',
    'E2E P42 project someday beta',
    'E2E P42 project someday alpha',
  ];
  await page.goto('/#/roadmap');
  await expect.poll(() => p42ColumnTitles(page)).toEqual(initial);

  const movingTitle = 'E2E P42 project later alpha';
  const movingCard = page.getByTestId('idea-card').filter({ hasText: movingTitle });
  for (const priority of ['next', 'now']) {
    const persisted = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/ideas/move'
    );
    await movingCard.getByTestId('priority-chip').click();
    await expect(movingCard.getByTestId('priority-chip')).toHaveText(priority);
    const response = await persisted;
    expect(response.ok(), await response.text()).toBe(true);
  }

  const afterPriority = [
    movingTitle,
    'E2E P42 project now beta',
    'E2E P42 project now alpha',
    'E2E P42 global now overlap',
    'E2E P42 project next alpha',
    'E2E P42 project next beta',
    'E2E P42 project later beta',
    'E2E P42 project someday beta',
    'E2E P42 project someday alpha',
  ];
  await expect.poll(() => p42ColumnTitles(page)).toEqual(afterPriority);
  await page.reload();
  await expect.poll(() => p42ColumnTitles(page)).toEqual(afterPriority);

  const rowsBeforeDrag = await roadmapRows(request);
  const selectedProject = rowsBeforeDrag.find((row) => row.title === movingTitle)?.project_id;
  if (!selectedProject) throw new Error('selected-project Plan 42 fixture is missing');
  const outsideMovedBand = (rows: IdeaRow[]): IdeaRow[] => rows.filter((row) =>
    row.title.startsWith(p42Prefix)
    && !(row.project_id === selectedProject && row.status === 'idea' && row.priority === 'now')
  );
  const untouchedBefore = outsideMovedBand(rowsBeforeDrag);

  const reordered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/ideas/reorder'
  );
  await dragCardOver(page, 'E2E P42 project now alpha', movingTitle);
  const reorderResponse = await reordered;
  expect(reorderResponse.ok(), await reorderResponse.text()).toBe(true);

  const afterDrag = [
    'E2E P42 project now alpha',
    movingTitle,
    'E2E P42 project now beta',
    'E2E P42 global now overlap',
    'E2E P42 project next alpha',
    'E2E P42 project next beta',
    'E2E P42 project later beta',
    'E2E P42 project someday beta',
    'E2E P42 project someday alpha',
  ];
  await expect.poll(() => p42ColumnTitles(page)).toEqual(afterDrag);
  expect(outsideMovedBand(await roadmapRows(request))).toEqual(untouchedBefore);
  await page.reload();
  await expect.poll(() => p42ColumnTitles(page)).toEqual(afterDrag);
  expect(outsideMovedBand(await roadmapRows(request))).toEqual(untouchedBefore);
});

test('My Tasks groups history and persists complete, reopen, and removal across reloads', async ({ page }) => {
  await page.goto('/#/tasks');
  await expect(page.getByRole('heading', { name: 'My Tasks', exact: true })).toBeVisible();
  const pendingTab = page.getByRole('tab', { name: /Pending/ });
  const completedTab = page.getByRole('tab', { name: /Completed/ });
  await expect(pendingTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'E2E Operator Plan', exact: true })).toBeVisible();
  const unlinked = page.getByTestId('task-group').filter({
    has: page.getByRole('heading', { name: 'Unlinked tasks', exact: true }),
  });
  await expect(unlinked).toHaveCount(1);
  await expect(unlinked.getByText('Assigned by ad-hoc-agent', { exact: true })).toBeVisible();
  await expect(unlinked.getByText('Assigned by other-ad-hoc-agent', { exact: true })).toBeVisible();
  await expect(page.getByText('E2E removed task', { exact: true })).toHaveCount(0);

  await completedTab.click();
  await expect(page.getByText('E2E completed task', { exact: true })).toBeVisible();
  await expect(page.getByText('E2E dismissed task', { exact: true })).toBeVisible();
  await expect(page.getByText('reason: waived for E2E proof', { exact: true })).toBeVisible();
  await expect(page.getByText('E2E removed task', { exact: true })).toHaveCount(0);

  await pendingTab.click();

  const completed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/user-tasks/status'
  );
  await page.getByRole('checkbox', { name: 'Complete E2E blocking task' }).click();
  expect((await completed).ok()).toBe(true);

  await page.reload();
  await page.getByRole('tab', { name: /Completed/ }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen E2E blocking task' })).toBeVisible();
  const reopened = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/user-tasks/status'
  );
  await page.getByRole('checkbox', { name: 'Reopen E2E blocking task' }).click();
  expect((await reopened).ok()).toBe(true);

  await page.reload();
  await expect(page.getByRole('tab', { name: /Pending/ })).toHaveAttribute('aria-selected', 'true');
  const planGroup = page.getByTestId('task-group').filter({ hasText: 'E2E Operator Plan' });
  await expect(planGroup.getByRole('checkbox', { name: 'Complete E2E blocking task' })).toBeVisible();

  await page.getByRole('tab', { name: /Completed/ }).click();
  await page.getByRole('button', { name: 'Remove E2E completed task' }).click();
  await expect(page.getByRole('dialog', { name: 'Remove E2E completed task' })).toBeVisible();
  const removed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/user-tasks/remove'
  );
  await page.getByRole('button', { name: 'Confirm remove' }).click();
  expect((await removed).ok()).toBe(true);

  await page.reload();
  await page.getByRole('tab', { name: /Completed/ }).click();
  await expect(page.getByText('E2E completed task', { exact: true })).toHaveCount(0);
  await expect(page.getByText('E2E removed task', { exact: true })).toHaveCount(0);
});

test('a small drag released over the same card is a no-op', async ({ page }) => {
  const reorderRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/ideas/reorder') reorderRequests.push(request.url());
  });
  await page.goto('/#/roadmap');
  const card = page.getByTestId('idea-card').filter({ hasText: 'E2E parked idea' });
  const box = await card.boundingBox();
  if (!box) throw new Error('card has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y + 10, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);

  expect(reorderRequests).toEqual([]);
  await expect(page.getByTestId('column-idea').getByTestId('idea-card')
    .filter({ hasText: 'E2E parked idea' })).toBeVisible();
});

test('dragging a card into Shipped persists across a reload', async ({ page }) => {
  await page.goto('/#/roadmap');
  const card = page.getByTestId('idea-card').filter({ hasText: 'E2E building item' });
  const shipped = page.getByTestId('column-shipped');
  await expect(card).toBeVisible();

  // dnd-kit's pointer sensor needs travel past its activation distance and
  // intermediate moves — a single hop is not enough to start the drag.
  const from = await card.boundingBox();
  const to = await shipped.boundingBox();
  if (!from || !to) throw new Error('card or column has no bounding box');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  const persisted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/ideas/reorder');
  await page.mouse.up();

  await expect(shipped.getByText('E2E building item', { exact: true })).toBeVisible();
  const response = await persisted;
  expect(response.ok(), await response.text()).toBe(true);

  await page.reload();
  await expect(
    page.getByTestId('column-shipped').getByText('E2E building item', { exact: true })
  ).toBeVisible();
});

test('click controls move a card to the adjacent column and persist', async ({ page }) => {
  await page.goto('/#/roadmap');
  const persisted = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/ideas/reorder'
  );
  await page.getByRole('button', { name: 'Move E2E planned item to building', exact: true }).click();
  const response = await persisted;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(
    page.getByTestId('column-building').getByText('E2E planned item', { exact: true })
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByTestId('column-building').getByText('E2E planned item', { exact: true })
  ).toBeVisible();
});

test('profile shows the approved fact under its category', async ({ page }) => {
  await page.goto('/#/profile');
  await expect(page.getByRole('heading', { name: 'preference', exact: true })).toBeVisible();
  const row = page.getByTestId('fact-row').filter({ hasText: 'E2E seeded fact' });
  await expect(row).toBeVisible();
  await expect(row.getByText('e2e-seed')).toBeVisible();
});

test('review approve removes a card and decrements the badge', async ({ page }) => {
  await page.goto('/#/review');
  const cards = page.getByTestId('review-card');
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();
  expect(before).toBeGreaterThan(0);

  const badge = page.getByTestId('review-badge');
  const badgeBefore = Number((await badge.textContent()) ?? '0');

  // Approve the cursor card (keyboard 'a' → POST /promote → remove).
  await page.locator('body').press('a');

  await expect(cards).toHaveCount(before - 1, { timeout: 10_000 });
  // Badge re-polls after the mutation.
  await expect
    .poll(async () => Number((await badge.textContent().catch(() => '0')) ?? '0'), { timeout: 10_000 })
    .toBeLessThan(badgeBefore);
});

test('graph exposes the showcase view-model attributes', async ({ page }) => {
  await page.goto('/#/graph');
  const root = page.locator('[data-graph-status]');
  await expect(root).toHaveAttribute('data-graph-status', 'ready', { timeout: 15_000 });
  await expect(root).toHaveAttribute('data-theme', 'organism');
  await expect(root).toHaveAttribute('data-view', '2d');
  // The landing fit establishes the real viewport, so the indicator reflects
  // actual magnification rather than the nominal store default. Assert
  // membership in the shipped power set, not one machine's framing (A16).
  const landingObjective = await root.getAttribute('data-objective');
  expect(['4', '10', '40', '100']).toContain(landingObjective);
  // Membership alone would still pass a permanently hard-coded indicator, so
  // prove it MOVES: pick a different power and require it to follow.
  const otherPower = landingObjective === '10' ? '40' : '10';
  await page.getByRole('button', { name: `${otherPower}×`, exact: true }).click();
  await expect(root).toHaveAttribute('data-objective', otherPower);
  // The heart is seeded at the top-degree node, so it must be non-empty.
  const heart = await root.getAttribute('data-heart');
  expect(heart).toBeTruthy();
  await expect(root.locator('[data-heart-vessels]')).toHaveAttribute('data-heart-vessels', '10');
});

test('Riverbed shell keeps one app nav and preserves graph actions across widths', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/graph');
  const root = page.locator('[data-graph-shell="riverbed"]');
  await expect(root).toHaveAttribute('data-graph-status', 'ready', { timeout: 15_000 });
  await expect(page.locator('nav')).toHaveCount(1);
  await expect(root.locator('[data-graph-controls="desktop"]')).toBeVisible();
  await expect(root.locator('[data-graph-canvas-region]')).toBeVisible();
  await expect(root.locator('[data-graph-drawer="anatomy"]')).toHaveCount(0);

  await page.keyboard.press('/');
  await page.getByPlaceholder('search the graph…').fill('hub_b');
  await page.getByRole('button', { name: /hub_b\s+function/ }).click();
  const drawer = root.locator('[data-graph-drawer="anatomy"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-node-heart]')).toHaveAttribute('data-node-heart', /^(0|1)$/);
  await expect(drawer.locator('[data-node-vessels]')).toHaveAttribute('data-node-vessels', '9');
  const selected = await root.getAttribute('data-selected');
  await expect(drawer.locator('[data-node-full-id]')).toHaveText(selected ?? '');
  await expect(drawer.locator('[data-node-full-id]')).toHaveText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  await expect(drawer.locator('[data-node-full-path]')).toHaveText('/tmp/e2e-repoA/src/hearts.ts:200');
  await expect(drawer.getByRole('button', { name: 'path' })).toBeEnabled();
  await expect(drawer.getByRole('button', { name: 'copy full node id' })).toBeEnabled();

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(root.locator('[data-graph-controls="desktop"]')).toBeHidden();
  await expect(root.locator('[data-graph-canvas-controls]')).toBeVisible();
  await expect(page.getByLabel('graph theme mobile')).toBeVisible();
  await expect(root.locator('[data-graph-filter-bank="mobile"] [data-legend-kinds]')).toBeVisible();
  await expect(root.locator('[data-graph-drawer="anatomy"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'reset to landing graph' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fit' })).toBeVisible();
});

test('theme switch repaints and persists without losing the graph', async ({ page }) => {
  await page.goto('/#/graph');
  const root = page.locator('[data-graph-status]');
  await expect(root).toHaveAttribute('data-graph-status', 'ready', { timeout: 15_000 });
  const before = await root.getAttribute('data-node-count');
  await page.getByLabel('graph theme', { exact: true }).selectOption('atlas');
  await expect(root).toHaveAttribute('data-theme', 'atlas');
  const controls = root.locator('[data-graph-controls="desktop"]');
  await expect(controls).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.9)');
  await expect(controls).toHaveCSS('color', 'rgb(43, 42, 38)');
  await page.keyboard.press('/');
  const spotlight = page.locator('[data-graph-spotlight="dialog"]');
  await expect(spotlight).toBeVisible();
  await expect(spotlight).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.9)');
  await expect(spotlight).toHaveCSS('color', 'rgb(43, 42, 38)');
  await page.getByPlaceholder('search the graph…').fill('hub_b');
  await page.getByRole('button', { name: /hub_b\s+function/ }).click();
  const drawer = root.locator('[data-graph-drawer="anatomy"]');
  await drawer.getByRole('button', { name: 'Impact' }).click();
  const prose = drawer.locator('.graph-prose');
  await expect(prose).toBeVisible({ timeout: 15_000 });
  await expect(prose).toHaveCSS('color', 'rgb(43, 42, 38)');
  expect(await root.getAttribute('data-node-count')).toBe(before);
  // Persistence goes through Plan 30's server-backed settings context, so a
  // reload must read the same operator value back from the existing endpoint.
  await page.reload();
  await expect(page.locator('[data-graph-status]')).toHaveAttribute('data-theme', 'atlas', { timeout: 15_000 });
});

test('async-default project keeps promotion current and reset returns to landing', async ({ page }) => {
  await page.goto('/#/graph');
  const root = page.locator('[data-graph-status]');
  await expect(root).toHaveAttribute('data-graph-status', 'ready', { timeout: 15_000 });
  await expect(root).toHaveAttribute('data-project', 'e2e-dash');
  const oldHeart = await root.getAttribute('data-heart');
  const before = Number(await root.getAttribute('data-node-count'));

  // hub_b is in the landing set but some of its nine leaves are not. Spotlight
  // selects/focuses the already-loaded hub without expansion; double-clicking
  // the centred canvas node performs the real promote+expand gesture.
  await page.keyboard.press('/');
  await page.getByPlaceholder('search the graph…').fill('hub_b');
  await page.getByRole('button', { name: /hub_b\s+function/ }).click();
  await expect(root).toHaveAttribute('data-selected', /.+/);
  const selected = await root.getAttribute('data-selected');
  expect(selected).toBeTruthy();
  expect(selected).not.toBe(oldHeart);

  // focusNode animates for 300 ms; wait for the selected node to settle at the
  // centre before exercising Cytoscape's real node-level double-click handler.
  await page.waitForTimeout(400);

  const canvas = page.locator('[data-graph-canvas="2d"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('graph canvas has no bounding box');
  await canvas.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(root).toHaveAttribute('data-heart', selected ?? '');
  await expect.poll(async () => Number(await root.getAttribute('data-node-count'))).toBeGreaterThan(before);

  // Old A3 / R5: ⌂ is a real landing reload, not just a heart-id assignment.
  await page.getByRole('button', { name: 'reset to landing graph' }).click();
  await expect.poll(async () => Number(await root.getAttribute('data-node-count'))).toBe(before);
  await expect(root).toHaveAttribute('data-heart', oldHeart ?? '');
  await expect(root).toHaveAttribute('data-selected', '');
});

test('the freshness banner reports both axes', async ({ page }) => {
  await page.goto('/#/graph');
  const banner = page.locator('[data-freshness-code]');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveAttribute('data-freshness-db', /ok|warn|info/);
  // Two sentences, one per axis — a single-line banner is the bug plan 28 fixed.
  expect(await banner.locator('p').count()).toBe(2);
});

test('the legend shows counted kinds and a working show-all', async ({ page }) => {
  await page.goto('/#/graph');
  const root = page.locator('[data-graph-status]');
  await expect(root).toHaveAttribute('data-graph-status', 'ready', { timeout: 15_000 });
  const legend = page.locator('[data-graph-filter-bank="desktop"] [data-legend-kinds]');
  await expect(legend).toBeVisible();
  expect(Number(await legend.getAttribute('data-legend-kinds'))).toBeGreaterThan(0);
  await expect(legend.getByText('show all')).toBeDisabled();

  // Hide a kind, then merge another node of that hidden kind through Spotlight.
  // The store projection must keep the visible count fixed and 3D must consume
  // that exact same count.
  const before = Number(await root.getAttribute('data-visible-node-count'));
  await legend.getByText(/function ·/).click();
  const hidden = Number(await root.getAttribute('data-visible-node-count'));
  expect(hidden).toBeLessThan(before);
  await page.keyboard.press('/');
  await page.getByPlaceholder('search the graph…').fill('hub_b_leaf_9');
  await page.getByRole('button', { name: /hub_b_leaf_9\s+function/ }).click();
  await expect(root).toHaveAttribute('data-visible-node-count', String(hidden));

  const toggle = page.locator('[data-view-toggle]');
  if ((await toggle.getAttribute('data-webgl')) === 'ok') {
    await toggle.click();
    await expect(page.locator('[data-3d-node-count]')).toHaveAttribute('data-3d-node-count', String(hidden));
  }

  await legend.getByText('show all').click();
  await expect(root).not.toHaveAttribute('data-visible-node-count', String(hidden));
});

test('a container resize preserves zoom instead of reframing the graph', async ({ page }) => {
  // Pins plan 29 A15's interaction contract: resize() updates renderer
  // dimensions only. Observable through the objective indicator, which tracks
  // real zoom — if resize refits, the fit zoom snaps the indicator to a
  // different power. Choosing an explicit objective first makes it deterministic.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/graph');
  const root = page.locator('[data-graph-status]');
  await expect(root).toHaveAttribute('data-graph-status', 'ready', { timeout: 15_000 });

  await page.getByRole('button', { name: '4×', exact: true }).click();
  await expect(root).toHaveAttribute('data-objective', '4');
  // data-zoom is the fixed-precision rendered zoom, reported by the renderer
  // through the store — a far finer observable than the four-band objective,
  // which lands in the same band either side of a refit and so cannot detect it.
  const zoomBefore = await root.getAttribute('data-zoom');
  expect(zoomBefore).toBeTruthy();

  // Shrink the container the way the drawer or a window resize would, and let
  // the ResizeObserver + render cycle settle before reading.
  await page.setViewportSize({ width: 1040, height: 900 });
  await page.waitForTimeout(300);
  await expect(root).toHaveAttribute('data-zoom', zoomBefore ?? '');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await expect(root).toHaveAttribute('data-zoom', zoomBefore ?? '');
  await expect(root).toHaveAttribute('data-objective', '4');

  // Fit remains the explicit way to reframe, and it IS meant to move the zoom —
  // that is the difference this contract draws.
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await expect.poll(async () => root.getAttribute('data-zoom')).not.toBe(zoomBefore);
});
