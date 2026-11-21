import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, fixtureMkdtemp, runScenario, tapBridge } from './harness.mjs';

runScenario(
  'os-file-open',
  async ({ app, page, userDataDir, log }) => {
    await tapBridge(page);
    const exe = await app.evaluate(({ app: electronApp }) => electronApp.getPath('exe'));
    const emit = (paths) =>
      app.evaluate(
        ({ app: electronApp }, argv) => {
          electronApp.emit('second-instance', null, argv);
        },
        [exe, ...paths],
      );
    const makeFolder = (name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      return dir;
    };
    const makeFile = (folder, name) => {
      const file = join(folder, name);
      writeFileSync(file, 'export const greeting = "hi from the OS";\n');
      return file;
    };
    const root = realpathSync(fixtureMkdtemp('conduit-osopen-'));
    const home = makeFolder('picker workspace');
    const attached = makeFolder('attached ü');
    const file = makeFile(home, 'hello ü.ts');
    const extra = makeFile(attached, 'extra.ts');
    const picker = page.getByRole('dialog', { name: 'Open in Conduit' });
    const open = picker.getByRole('button', { name: 'Open session', exact: true });
    const inField = picker.getByRole('button', { name: 'Open in', exact: true });
    const windowField = picker.getByRole('button', { name: 'Window', exact: true });
    const existing = page.getByRole('menuitem').filter({
      has: page.getByText(home, { exact: true }),
    });
    const setAsk = async (win, enabled) => {
      await win.evaluate(() => {
        window.agentDeck.subscribe((message) => {
          if (message.type === 'state') window.__osOpenAsk = message.settings.askOsOpen;
        });
      });
      await win.locator('.footbtn[title^="Settings"]').click();
      const ask = win.getByRole('switch', {
        name: 'Ask how to open files and folders from the OS',
      });
      assert(
        (await ask.getAttribute('aria-checked')) === String(!enabled),
        'starting ask setting differs',
      );
      await ask.click();
      await win.waitForFunction((value) => window.__osOpenAsk === value, enabled);
      await win.locator('.settings-page__back').click();
    };
    const visibleTab = (win, filePath, active = false) =>
      win.waitForFunction(
        ({ id, active }) =>
          !!document.querySelector(
            `[data-tabid="${CSS.escape(id)}"]${active ? '.tab--active' : ''}`,
          ),
        { id: `file:${filePath}`, active },
      );
    const enabled = (button) =>
      page.waitForFunction(
        (label) =>
          [...document.querySelectorAll('.ns button')].some(
            (el) => el.textContent.trim() === label && !el.disabled,
          ),
        button,
      );

    await emit([file, home, attached, extra]);
    await picker.waitFor({ state: 'visible' });
    assert((await inField.textContent()) === 'New session', 'first open should seed New session');
    assert(
      (await windowField.textContent()) === 'This window',
      'first open should seed This window',
    );
    assert(
      await picker.evaluate((el) => {
        const outer = el.getBoundingClientRect();
        return (
          outer.top >= 0 &&
          outer.left >= 0 &&
          outer.bottom <= innerHeight &&
          outer.right <= innerWidth
        );
      }),
      'picker frame should fit the receiving window',
    );
    await enabled('Start session');
    await page.keyboard.press('Enter');
    await picker.waitFor({ state: 'hidden' });
    await visibleTab(page, file);
    await visibleTab(page, extra, true);
    const created = await page.evaluate(
      (home) => window.__sessions.find((s) => s.home === home),
      home,
    );
    assert(
      created?.roots.includes(attached),
      'the second folder should be attached to the new session',
    );
    log('Enter opened both files in the session with the requested home and attached root');

    const noMatch = makeFolder('queued folder');
    await emit([noMatch]);
    await picker.getByText(noMatch, { exact: true }).waitFor();
    await emit([home]);
    assert(
      await picker.getByText(noMatch, { exact: true }).isVisible(),
      'second open replaced the first picker',
    );
    await page.keyboard.press('Escape');
    await picker.getByText(home, { exact: true }).waitFor();
    assert(
      await page.evaluate((p) => !window.__sessions.some((s) => s.home === p), noMatch),
      'Escape created a session',
    );
    await inField.click();
    await existing.click();
    await open.click();
    await picker.waitFor({ state: 'hidden' });
    assert(
      await page.evaluate((p) => window.__sessions.filter((s) => s.home === p).length === 1, home),
      'existing session choice created a duplicate',
    );
    log('Escape cancelled the first request and the queued folder reused its existing session');

    const coldDir = makeFolder('cold one');
    const coldFile = makeFile(coldDir, 'cold.ts');
    await app.evaluate(() => global.__osOpenColdHook.setRendererReady(false));
    await emit([coldFile]);
    const deadline = Date.now() + 10_000;
    let depth = 0;
    while (!depth && Date.now() < deadline) {
      depth = await app.evaluate(() => global.__osOpenColdHook.pendingCount());
      if (!depth) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(depth === 1 && !(await picker.isVisible()), 'cold open should wait in the host queue');
    await app.evaluate(() => global.__osOpenColdHook.flush());
    await picker.getByText(coldFile, { exact: true }).waitFor();
    assert(
      (await inField.textContent()) === 'New session',
      'existing choice should fall back with no match',
    );
    await inField.click();
    await page.getByRole('menuitem', { name: 'Other sessions' }).waitFor();
    await existing.click();
    await windowField.click();
    await page.getByRole('menuitem', { name: 'New window', exact: true }).click();
    const nextWindow = app.waitForEvent('window');
    await open.click();
    const moved = await nextWindow;
    await picker.waitFor({ state: 'hidden' });
    await visibleTab(moved, coldFile, true);
    await page.waitForFunction((id) => !window.__sessions.some((s) => s.id === id), created.id);
    log(
      'cold readiness flush showed the picker, and Other sessions moved the session to a new window',
    );

    await setAsk(moved, false);
    const saved = JSON.parse(readFileSync(join(userDataDir, 'os-open.json'), 'utf8'));
    assert(
      saved.mode === 'existing' &&
        saved.window === 'new' &&
        saved.agentId === created.agentId &&
        saved.projectId === null,
      'stored choice did not match the accepted session and destination',
    );
    const skippedFile = makeFile(home, 'skipped.ts');
    const bypassWindow = app.waitForEvent('window');
    await emit([skippedFile]);
    const bypassed = await bypassWindow;
    await visibleTab(bypassed, skippedFile, true);
    assert(
      !(await moved.getByRole('dialog', { name: 'Open in Conduit' }).isVisible()),
      'disabled setting still showed the picker',
    );
    log('turning off the picker applied the saved existing-session and new-window choice');

    await setAsk(bypassed, true);
    const freshDir = makeFolder('new window home');
    const freshFile = makeFile(freshDir, 'new-window.ts');
    const freshPicker = bypassed.getByRole('dialog', { name: 'Open in Conduit' });
    await emit([freshFile]);
    await freshPicker.waitFor({ state: 'visible' });
    assert(
      (await freshPicker.getByRole('button', { name: 'Open in', exact: true }).textContent()) ===
        'New session' &&
        (await freshPicker.getByRole('button', { name: 'Window', exact: true }).textContent()) ===
          'New window',
      'no matching session should preserve the saved window and default to creation',
    );
    await freshPicker.getByRole('button', { name: 'Start session', exact: true }).waitFor();
    const freshWindow = app.waitForEvent('window');
    await freshPicker.getByRole('button', { name: 'Start session', exact: true }).click();
    await visibleTab(await freshWindow, freshFile, true);
    log('New session created the destination window and opened the file there');
  },
  { openFolder: false },
);
