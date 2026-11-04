import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const MSG =
  'Rust toolchain not found: install rustup (https://rustup.rs) to run the tray-helper checks';

function runCheckRustSnippet(body: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('check-rust.mjs', () => {
  it('reports the exact install message when cargo is missing', () => {
    const r = runCheckRustSnippet(`
      import { checkRust, TRAY_RUST_INSTALL_MESSAGE } from './tools/check-rust.mjs';
      const out = checkRust(() => ({ status: 1, stdout: '', stderr: '' }));
      if (out.message !== TRAY_RUST_INSTALL_MESSAGE) process.exit(2);
      if (out.message !== ${JSON.stringify(MSG)}) process.exit(3);
    `);
    expect(r.status, r.stderr).toBe(0);
  });

  it('succeeds when cargo responds', () => {
    const r = runCheckRustSnippet(`
      import { checkRust } from './tools/check-rust.mjs';
      if (!checkRust(() => ({ status: 0, stdout: 'cargo 1.98.1', stderr: '' })).ok) process.exit(2);
    `);
    expect(r.status, r.stderr).toBe(0);
  });
});
