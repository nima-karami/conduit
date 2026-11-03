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
writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, settings: {} }));

async function logNotesFailure(app, page, log) {
  try {
    const inputs = await app.evaluate(({ app }, expectedVersion) => {
      const fs = require('node:fs');
      const path = require('node:path');
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      const settingsExist = fs.existsSync(settingsPath);
      const persisted = settingsExist ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : null;
      const changelogPath = app.isPackaged
        ? path.join(process.resourcesPath, 'CHANGELOG.md')
        : path.join(app.getAppPath(), 'CHANGELOG.md');
      return {
        expectedVersion,
        version: app.getVersion(),
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        settingsPath,
        settingsExist,
        settingsSchemaVersion: persisted?.version ?? null,
        lastSeenVersion: persisted?.settings?.lastSeenVersion ?? null,
        changelogPath,
        changelogExists: fs.existsSync(changelogPath),
      };
    }, currentVersion);
    log(`release-notes host inputs: ${JSON.stringify(inputs)}`);
  } catch (error) {
    log(`release-notes host diagnostics unavailable: ${error.stack ?? error}`);
  }
  try {
    const decision = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const unsubscribe = window.agentDeck.subscribe((message) => {
            if (message.type !== 'releaseNotes') return;
            clearTimeout(timer);
            unsubscribe();
            resolve({
              version: message.version,
              notesFound: !!message.notes?.trim(),
              notesLength: message.notes?.length ?? 0,
              showToast: message.showToast,
            });
          });
          const timer = setTimeout(() => {
            unsubscribe();
            resolve({ responseTimedOut: true });
          }, 2000);
          window.agentDeck.post({ type: 'getReleaseNotes' });
        }),
    );
    log(`release-notes diagnostic response: ${JSON.stringify(decision)}`);
  } catch (error) {
    log(`release-notes renderer diagnostics unavailable: ${error.stack ?? error}`);
  }
}

runScenario(
  'update-post-update',
  async ({ app, page, log }) => {
    log(
      `release-notes seed: ${JSON.stringify({ userDataDir, schemaVersion: 1, lastSeenVersion: null, expectedVersion: currentVersion, notesFound: !!section.trim() })}`,
    );
    const toast = page.locator('[data-post-update-toast]');
    try {
      await toast.waitFor({ state: 'visible', timeout: 10000 });
    } catch (error) {
      await logNotesFailure(app, page, log);
      throw error;
    }
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
    // The notes body may itself mention the relaunch control, so assert on the control.
    assert(
      (await dialog.getByRole('button', { name: 'Relaunch to update' }).count()) === 0,
      'installed notes omit Relaunch',
    );
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
