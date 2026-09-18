import { describe, expect, it } from 'vitest';
import {
  MAX_PREVIEW_BYTES,
  type PreviewStat,
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

const file = (size: number) => (): PreviewStat => ({ kind: 'file', size });
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
    const dir = previewVerdictForPath(`${ROOT}/sub`, ROOTS, () => ({ kind: 'other' }), identity);
    expect(dir.ok).toBe(false);
    if (dir.ok) throw new Error('expected a refusal');
    expect(dir.reason).toBe('missing');
    expect(dir.status).toBe(404);

    const gone = previewVerdictForPath(
      `${ROOT}/gone.html`,
      ROOTS,
      () => ({ kind: 'missing' }),
      identity,
    );
    expect(gone.ok).toBe(false);
    if (gone.ok) throw new Error('expected a refusal');
    expect(gone.reason).toBe('missing');
    expect(gone.status).toBe(404);
  });

  it('reports an unreadable file as unreadable, not as missing', () => {
    // A single nullable stat result collapsed ENOENT and EACCES together, so a file the user
    // could see but not open reported "no longer exists" — a lie about why it failed.
    const denied = previewVerdictForPath(
      `${ROOT}/locked.html`,
      ROOTS,
      () => ({ kind: 'unreadable', detail: 'EACCES' }),
      identity,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('expected a refusal');
    expect(denied.reason).toBe('unreadable');
    expect(denied.status).toBe(500);
    expect(denied.detail).toBe('EACCES');
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
