import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const MANIFEST = join(ROOT, 'native/tray/Cargo.toml');
const LOCK = join(ROOT, 'native/tray/Cargo.lock');

function crateNamesFromCargoTree(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const m = /^([A-Za-z0-9_-]+) v/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return names;
}

describe('crateNamesFromCargoTree', () => {
  it('collects unique crate names from tree output', () => {
    expect(
      [...crateNamesFromCargoTree('serde v1.0.0\n  serde_json v1.0.0\nwindows-sys v0.59.0')].sort(),
    ).toEqual(['serde', 'serde_json', 'windows-sys']);
  });
});

describe('tray helper THIRD_PARTY notices', () => {
  const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8');

  it('names the conduit-tray helper binary section', () => {
    expect(notices).toContain('conduit-tray.exe');
  });

  it.skipIf(!existsSync(LOCK))(
    'lists every runtime crate from the tray lock in THIRD_PARTY_NOTICES',
    () => {
      const tree = spawnSync(
        'cargo',
        ['tree', '--manifest-path', MANIFEST, '--locked', '-e', 'normal', '--prefix', 'none'],
        { encoding: 'utf8', cwd: ROOT },
      );
      expect(tree.status, tree.stderr).toBe(0);
      const names = crateNamesFromCargoTree(tree.stdout);
      names.delete('conduit-tray');
      for (const name of names) {
        expect(notices, `missing notice entry for ${name}`).toMatch(
          new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
        );
      }
    },
  );
});
