import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeLockCrates } from './tray-lock-notices';

const ROOT = join(__dirname, '..', '..');
const MANIFEST = join(ROOT, 'native/tray/Cargo.toml');
const LOCK = join(ROOT, 'native/tray/Cargo.lock');

describe('tray helper THIRD_PARTY notices', () => {
  const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8');

  it('names the conduit-tray helper binary section', () => {
    expect(notices).toContain('conduit-tray.exe');
    expect(notices).toContain('resources/licenses/tray/MIT.txt');
  });

  const manifestPresent = existsSync(MANIFEST);

  it.skipIf(!manifestPresent)(
    'lists every runtime crate from the tray lock in THIRD_PARTY_NOTICES',
    () => {
      if (!existsSync(LOCK)) {
        throw new Error('native/tray/Cargo.toml exists but Cargo.lock is missing');
      }
      const manifest = readFileSync(MANIFEST, 'utf8');
      const lock = readFileSync(LOCK, 'utf8');
      for (const name of runtimeLockCrates(lock, manifest)) {
        expect(notices, `missing notice entry for ${name}`).toMatch(
          new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
        );
      }
    },
  );
});
