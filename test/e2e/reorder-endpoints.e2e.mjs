import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  finishScenario,
  launchElectron,
  makeLog,
  openSession,
  profileDir,
  REPO,
} from './harness.mjs';
import { groupTabs, openFromExplorer, same, tabOf } from './split-editor-helpers.mjs';

const log = makeLog('reorder-endpoints');
const require = createRequire(import.meta.url);
const profile = profileDir('reorder');
const repo = mkdtempSync(join(tmpdir(), 'conduit-reorder-'));
for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(repo, name), 'export {};\n');

async function launch() {
  const app = await launchElectron(
    {
      executablePath: require('electron'),
      args: [`--user-data-dir=${profile}`, '.'],
      cwd: REPO,
    },
    { headless: true },
  );
  const page = await app.firstWindow();
  await page.waitForSelector('.centerpane', { timeout: 20000 });
  return { app, page };
}

async function drag(page, source, target, fraction, cue) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  assert(from && to, 'drag source and target must be visible');
  const x = to.x + to.width * fraction;
  const y = to.y + to.height / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 16 });
  await page.mouse.move(x + 1, y);
  if (cue) {
    const indicator = target.and(page.locator(`[data-reorder-edge="${cue}"]`));
    await indicator.waitFor({ timeout: 3000 });
    const accentWidth = await indicator.evaluate(
      (item) => getComputedStyle(item, '::before').width,
    );
    check(`insertion cue at ${cue} edge`, accentWidth, '2px');
  }
  await page.mouse.up();
}

const dockSelectors = ['.panel--sessions', '.centerpane', '.panel--explorer'];
const dockOrder = (page) =>
  page.evaluate(
    (selectors) =>
      selectors
        .map((selector) => [selector, document.querySelector(selector).getBoundingClientRect().x])
        .sort((a, b) => a[1] - b[1])
        .map(([selector]) => selector),
    dockSelectors,
  );

const failures = [];
function check(label, actual, expected) {
  log(label, JSON.stringify(actual));
  if (!same(actual, expected)) failures.push(`${label}: expected ${JSON.stringify(expected)}`);
}

let code = 0;
try {
  const { app, page } = await launch();
  await openSession(page, { path: repo.replace(/\\/g, '/') });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) await openFromExplorer(page, name);

  const tab = (name) => tabOf(page, 1, name);
  await drag(page, tab('c.ts'), tab('a.ts'), 0.25, 'before');
  check('tabs first', await groupTabs(page, 1), ['c.ts', 'a.ts', 'b.ts']);
  await drag(page, tab('c.ts'), tab('b.ts'), 0.75, 'after');
  check('tabs last', await groupTabs(page, 1), ['a.ts', 'b.ts', 'c.ts']);
  await drag(page, tab('c.ts'), tab('a.ts'), 0.75);
  const expectedTabs = ['a.ts', 'c.ts', 'b.ts'];
  check('tabs middle', await groupTabs(page, 1), expectedTabs);
  await drag(page, tab('c.ts'), tab('c.ts'), 0.75);
  check('tabs self drop', await groupTabs(page, 1), expectedTabs);
  check('cue clears after the drop', await page.locator('[data-reorder-edge]').count(), 0);

  const [sessions, center, explorer] = dockSelectors;
  const grip = page.locator('.centerpane .tabbar__tail');
  await drag(page, grip, page.locator(sessions), 0.25, 'before');
  check('dock first', await dockOrder(page), [center, sessions, explorer]);
  await drag(page, grip, page.locator(explorer), 0.75, 'after');
  check('dock last', await dockOrder(page), [sessions, explorer, center]);
  await drag(page, grip, page.locator(sessions), 0.75);
  check('dock middle', await dockOrder(page), dockSelectors);
  const expectedDock = [center, sessions, explorer];
  await drag(page, grip, page.locator(sessions), 0.25);
  check('dock before relaunch', await dockOrder(page), expectedDock);
  await closeApp(app, page);

  const second = await launch();
  const restored = second.page.locator('.session', { hasText: repo.split(/[/\\]/).pop() }).first();
  await restored.click({ timeout: 30000 });
  await tabOf(second.page, 1, 'c.ts').waitFor({ timeout: 20000 });
  check('restored tabs', await groupTabs(second.page, 1), expectedTabs);
  check('restored dock', await dockOrder(second.page), expectedDock);
  assert(failures.length === 0, failures.join('\n'));
  log('PASS ✓ reorder endpoints and persistence');
} catch (error) {
  log('FAIL ✗', failures.join('\n'), error.stack);
  code = 1;
}
await finishScenario(code);
