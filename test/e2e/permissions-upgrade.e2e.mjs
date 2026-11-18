import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, profileDir, runScenario } from './harness.mjs';

const userDataDir = profileDir();
const policyDir = join(userDataDir, 'conduit-mcp');
const policyPath = join(policyDir, 'policy.json');
const assignment = {
  point: { kind: 'session', sessionId: 'historical-lead' },
  assignment: { profileId: 'lead', onScreenOnly: true, exceptions: [] },
};
mkdirSync(policyDir, { recursive: true });
writeFileSync(
  policyPath,
  JSON.stringify({
    version: 2,
    profiles: [],
    assignments: [assignment],
    overrides: [],
    migratedFrom: 'v0.64',
    notes: { onScreenOnlyOffered: ['historical-lead'] },
  }),
);

await runScenario(
  'permissions-upgrade',
  async ({ page, log }) => {
    const notice = page.getByRole('dialog', { name: 'Permissions have a new home' });
    await notice.getByRole('rowheader', { name: 'historical-lead' }).waitFor();
    const evidence = process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, '00-upgrade.png') });
    }
    const done = notice.getByRole('button', { name: 'Done' });
    await page.waitForFunction(
      () => document.activeElement?.closest('.permissions-upgrade') !== null,
      undefined,
      { timeout: 5_000 },
    );
    await done.press('Enter');
    try {
      await notice.waitFor({ state: 'hidden', timeout: 10_000 });
    } catch (failure) {
      log(
        `upgrade notice feedback: ${(await notice.getByRole('alert').allTextContents()).join(' ')}`,
      );
      throw failure;
    }
    const saved = JSON.parse(readFileSync(policyPath, 'utf8'));
    assert(saved.notes.migrationAcknowledged === true, 'upgrade acknowledgement was not durable');
    assert(
      saved.assignments.some(
        (entry) =>
          entry.point.sessionId === 'historical-lead' &&
          entry.assignment.profileId === 'lead' &&
          entry.assignment.onScreenOnly === true,
      ),
      'acknowledgement altered the migrated assignment',
    );
    log('historical upgrade notice and durable keyboard acknowledgement verified');
  },
  { userDataDir, openFolder: false },
);
