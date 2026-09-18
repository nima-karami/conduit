import { describe, expect, it } from 'vitest';
import {
  MAX_PREVIEW_BYTES,
  previewVerdictForPath,
  rootForToken,
  rootTokenFor,
} from '../../electron/preview-protocol';
import { isValidRootToken } from '../../src/preview-url';

// POSIX-shaped fixtures ONLY: isInsideRoot branches on process.platform and resolves through
// node:path, so a Windows drive path resolves to nonsense on the ubuntu CI runner that owns
// the gate (src/path-guard.ts:35, plan Revision 2 S9).
const ROOT = '/work/proj';
const ROOTS = [ROOT, '/work/other'];

const file = (size: number) => () => ({ isFile: true, size });
const identity = (p: string) => p;

describe('previewVerdictForPath — the confinement decision', () => {
  it('serves a file inside a root', () => {
    const v = previewVerdictForPath(`${ROOT}/a.html`, ROOTS, file(120), identity);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error('expected ok');
    expect(v.contentType).toBe('text/html');
    expect(v.path).toBe(`${ROOT}/a.html`);
  });

  it('refuses a path outside every root', () => {
    const v = previewVerdictForPath('/etc/passwd', ROOTS, file(12), identity);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected a refusal');
    expect(v.reason).toBe('blocked');
    expect(v.status).toBe(404);

    // Real path lands back INSIDE a root, so only the lexical check can refuse this one.
    const decoy = previewVerdictForPath('/etc/passwd', ROOTS, file(12), () => `${ROOT}/decoy.html`);
    expect(decoy.ok).toBe(false);
    if (decoy.ok) throw new Error('expected a refusal');
    expect(decoy.reason).toBe('blocked');
    expect(decoy.status).toBe(404);
  });

  it('refuses a path whose real path escapes the root', () => {
    // Lexically contained, so isInsideAnyRoot alone passes it; only the realPath re-check
    // catches the symlink escape. This is why both run.
    const v = previewVerdictForPath(
      `${ROOT}/link.html`,
      ROOTS,
      file(40),
      () => '/elsewhere/secret.html',
    );
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected a refusal');
    expect(v.reason).toBe('blocked');
    expect(v.status).toBe(404);
  });

  it('refuses a directory and a missing file', () => {
    const dir = previewVerdictForPath(
      `${ROOT}/sub`,
      ROOTS,
      () => ({ isFile: false, size: 0 }),
      identity,
    );
    expect(dir.ok).toBe(false);
    if (dir.ok) throw new Error('expected a refusal');
    expect(dir.reason).toBe('missing');
    expect(dir.status).toBe(404);

    const gone = previewVerdictForPath(`${ROOT}/gone.html`, ROOTS, () => null, identity);
    expect(gone.ok).toBe(false);
    if (gone.ok) throw new Error('expected a refusal');
    expect(gone.reason).toBe('missing');
    expect(gone.status).toBe(404);
  });

  it('refuses a file over the cap', () => {
    const over = previewVerdictForPath(
      `${ROOT}/big.html`,
      ROOTS,
      file(MAX_PREVIEW_BYTES + 1),
      identity,
    );
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('expected a refusal');
    expect(over.reason).toBe('too-large');
    expect(over.status).toBe(413);

    const atCap = previewVerdictForPath(
      `${ROOT}/big.html`,
      ROOTS,
      file(MAX_PREVIEW_BYTES),
      identity,
    );
    expect(atCap.ok).toBe(true);
  });
});

describe('the per-run root token table', () => {
  it('mints a stable token per root and resolves it back', () => {
    const a = '/work/alpha';
    const b = '/work/beta';

    const tokenA = rootTokenFor(a);
    expect(rootTokenFor(a)).toBe(tokenA);
    expect(rootForToken(tokenA)).toBe(a);

    const tokenB = rootTokenFor(b);
    expect(tokenB).not.toBe(tokenA);
    expect(rootForToken(tokenB)).toBe(b);

    expect(isValidRootToken(tokenA)).toBe(true);
    expect(isValidRootToken(tokenB)).toBe(true);
    expect(rootForToken('nosuchtokenatall')).toBeUndefined();
  });
});
