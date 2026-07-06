/**
 * skill-install — the skill installer's host/FS boundary, which units can't cover: copying a
 * bundled SKILL.md folder into a project's and the user-global `.claude/skills`. Drives both the
 * bridge directly (deterministic FS asserts) and the Settings → Skills UI (proves the panel wires
 * to the same host path). `CONDUIT_HOME` is pointed at a temp dir so "global" never touches the
 * real `~/.claude` (the production-inert test seam, spec §Test seam).
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog } from './harness.mjs';

const log = makeLog('skill-install');

// Set BEFORE launch so the electron child inherits it (Playwright inherits process.env).
const tmpHome = mkdtempSync(join(tmpdir(), 'conduit-skills-home-'));
const tmpProject = mkdtempSync(join(tmpdir(), 'conduit-skills-proj-'));
process.env.CONDUIT_HOME = tmpHome;

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;

  // 1) Bridge → host → FS: install into an arbitrary project root.
  const projRes = await page.evaluate(
    (root) => window.agentDeck.skills.install('conduit-architecture', 'project', root),
    tmpProject,
  );
  assert(projRes.ok, `project install should succeed: ${JSON.stringify(projRes)}`);
  const skillDir = join(tmpProject, '.claude', 'skills', 'conduit-architecture');
  assert(existsSync(join(skillDir, 'SKILL.md')), 'SKILL.md should land in the project');
  assert(
    existsSync(join(skillDir, 'architecture.schema.json')),
    'companion files (schema) should copy too',
  );
  log('project install landed the full skill folder ✓');

  // list() should now report it installed for that project.
  const listed = await page.evaluate((root) => window.agentDeck.skills.list(root), tmpProject);
  const arch = listed.find((s) => s.id === 'conduit-architecture');
  assert(arch && arch.project.status === 'installed', 'status should flip to installed');
  assert(
    listed.length >= 2 && listed.some((s) => s.id === 'conduit-plan'),
    'the bundle should enumerate both seeded skills',
  );
  log('list() reflects install status ✓');

  // 2) UI path: open Settings → Skills and install a skill to user-global via a real click.
  await page.locator('.footbtn[title^="Settings"]').click();
  await page.locator('.settings__navitem', { hasText: 'Skills' }).click();
  await page.waitForSelector('.skillrow', { timeout: 5000 });
  const rows = await page.locator('.skillrow').count();
  assert(rows >= 2, `the Skills panel should list the bundled skills (saw ${rows})`);

  const planRow = page.locator('.skillrow', { hasText: 'Conduit Plan' });
  await planRow.getByRole('button', { name: /→ user/ }).click();
  await planRow.locator('.skillrow__msg').waitFor({ state: 'visible', timeout: 5000 });
  const msg = await planRow.locator('.skillrow__msg').textContent();
  assert(msg && !/error/i.test(msg), `install message should be a success, got: ${msg}`);
  assert(
    existsSync(join(tmpHome, '.claude', 'skills', 'conduit-plan', 'SKILL.md')),
    'user-global install should land under CONDUIT_HOME',
  );
  // The button relabels to Reinstall once installed at that destination.
  await planRow
    .getByRole('button', { name: /Reinstall → user/ })
    .waitFor({ state: 'visible', timeout: 5000 });
  log('UI install to user-global landed + relabelled ✓');

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[skill-install] FAIL', err);
  if (launched) await closeApp(launched.app, launched.page).catch(() => {});
  process.exit(1);
}
