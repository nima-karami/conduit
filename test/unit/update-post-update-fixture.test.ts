import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { changelogSection } from '../../src/changelog';
import { releaseNotesDecision } from '../../src/release-notes-decision';
import { DEFAULT_SETTINGS, restoreSettings, serializeSettings } from '../../src/settings';

const { profiles, runScenario } = vi.hoisted(() => ({
  profiles: [] as string[],
  runScenario: vi.fn(),
}));
vi.mock('../e2e/harness.mjs', () => ({
  profileDir: () => {
    const scratch = join(tmpdir(), 'Codex-scratch');
    mkdirSync(scratch, { recursive: true });
    const profile = mkdtempSync(join(scratch, 'update-notes-fixture-'));
    profiles.push(profile);
    return profile;
  },
  runScenario,
  assert: vi.fn(),
}));

beforeAll(async () => {
  const scenarioModule = '../e2e/update-post-update.e2e.mjs';
  await import(scenarioModule);
});
afterAll(() => {
  for (const profile of profiles) rmSync(profile, { recursive: true, force: true });
});

describe('post-update scenario startup fixture', () => {
  it('seeds the actual settings schema in the profile passed to the harness', () => {
    const profile = profiles[0];
    const seed = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    expect(seed.version).toBe(JSON.parse(serializeSettings(DEFAULT_SETTINGS)).version);
    expect(runScenario.mock.calls[0][2].userDataDir).toBe(profile);
  });

  it('restores legacy settings and shows bundled notes without consuming them before acknowledgement', () => {
    const version = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ).version;
    const notes = changelogSection(
      readFileSync(join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'),
      version,
    );
    const settings = restoreSettings(readFileSync(join(profiles[0], 'settings.json'), 'utf8'));
    expect(settings.lastSeenVersion).toBeUndefined();
    expect(notes).not.toBeNull();
    expect(releaseNotesDecision(version, settings.lastSeenVersion, notes, true)).toEqual({
      showToast: true,
      persistVersion: null,
    });
  });
});
