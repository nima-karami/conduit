import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, profileDir, runScenario } from './harness.mjs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const currentVersion = packageJson.version;
const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const section = changelog
  .match(
    new RegExp(`^## \\[${currentVersion.replaceAll('.', '\\.')}\\].*?\\r?\\n([\\s\\S]*)`, 'm'),
  )?.[1]
  ?.split(/^## \[/m)[0];
if (!section?.trim())
  throw new Error(`No changelog section for installed version ${currentVersion}`);
const sample = section
  .split(/\r?\n/)
  .find((line) => /^- /.test(line))
  ?.replace(/^- /, '')
  .replaceAll('**', '')
  .replaceAll('`', '')
  .split('. ')[0]
  ?.concat('.')
  .trim();

const userDataDir = profileDir('update-post-update');
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: packageJson.version, settings: {} }),
);

runScenario(
  'update-post-update',
  async ({ page, log }) => {
    const toast = page.locator('[data-post-update-toast]');
    await toast.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(
      (version) =>
        document
          .querySelector('[data-post-update-toast] [role="status"]')
          ?.textContent?.includes(`Updated to v${version}`),
      currentVersion,
      { timeout: 5000 },
    );
    assert(
      (await toast.textContent())?.includes(`Updated to v${currentVersion}`),
      'toast names the installed version',
    );
    const settingsFile = join(userDataDir, 'settings.json');
    const deadline = Date.now() + 5000;
    let persisted;
    while (Date.now() < deadline) {
      try {
        persisted = JSON.parse(readFileSync(settingsFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (persisted?.settings?.lastSeenVersion === currentVersion) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(
      persisted?.settings?.lastSeenVersion === currentVersion,
      `mounted toast acknowledgement persists lastSeenVersion ${currentVersion}`,
    );
    await toast.getByRole('button', { name: "What's new" }).click();
    await toast.waitFor({ state: 'detached', timeout: 5000 });
    const dialog = page.locator('[role="dialog"][data-whats-new]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    assert(
      (await dialog
        .getByRole('heading', {
          name: `What's new in v${currentVersion}`,
          exact: true,
        })
        .count()) === 1,
      'installed notes dialog names the current version',
    );
    const dialogText = await dialog.textContent();
    assert(
      !dialogText?.includes('you have v'),
      'installed notes omit the incoming-update sub-line',
    );
    assert(!dialogText?.includes('Relaunch to update'), 'installed notes omit Relaunch');
    if (sample) {
      const normalized = (value) => value?.replace(/\s+/g, ' ').trim() ?? '';
      assert(
        normalized(dialogText).includes(normalized(sample)),
        'dialog renders content from the bundled changelog section',
      );
    }
    await dialog.getByRole('button', { name: 'Later' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 5000 });

    await page.addInitScript(() => {
      window.__releaseNotesSeen = [];
      const attach = () => {
        const bridge = window.agentDeck;
        if (!bridge || typeof bridge.subscribe !== 'function') return false;
        bridge.subscribe((message) => {
          if (message.type === 'releaseNotes') window.__releaseNotesSeen.push(message);
        });
        return true;
      };
      if (!attach()) {
        const timer = setInterval(() => {
          if (attach()) clearInterval(timer);
        }, 25);
        setTimeout(() => clearInterval(timer), 20000);
      }
    });
    await page.reload();
    await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
    await page.waitForSelector('[data-toast-stack]', { state: 'attached', timeout: 10000 });
    await page.waitForFunction(
      (version) =>
        window.__releaseNotesSeen?.some(
          (message) => message.version === version && message.showToast === false,
        ),
      currentVersion,
      { timeout: 10000 },
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert(
      (await page.locator('[data-post-update-toast]').count()) === 0,
      'persisted mount acknowledgement prevents the toast from repeating after renderer reload',
    );
    log(
      `legacy settings showed the installed notes once for v${currentVersion}; reload did not repeat it`,
    );
  },
  { userDataDir },
);
