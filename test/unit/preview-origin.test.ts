import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type PreviewStat,
  previewStat,
  previewTargetForPath,
  previewVerdictForRequest,
  rootTokenFor,
} from '../../electron/preview-protocol';
import { realPathLeaf } from '../../src/path-guard';

// One origin per root (ADR 0005 §1) only holds if a request under root X's token can never be
// answered with a file of another open root Y. POSIX-shaped fixtures, as in preview-verdict.test.ts.
const X = '/work/x';
const Y = '/work/y';
const OPEN = [X, Y];

const file = (): PreviewStat => ({ kind: 'file', size: 10 });
const identity = (p: string) => p;
// path.join on win32 yields backslashes; normalise so one fake serves both platforms.
const linkTo = (from: string, to: string) => (p: string) => p.replace(/\\/g, '/').replace(from, to);
const req = (root: string, ...segments: string[]) => ({ token: rootTokenFor(root), segments });

describe('previewVerdictForRequest — a token answers only for its own root', () => {
  it('refuses a link inside X whose real path is a file of open root Y', () => {
    const realPath = linkTo(`${X}/link-to-y`, Y);
    const v = previewVerdictForRequest(req(X, 'link-to-y', 'secret.txt'), OPEN, file, realPath);
    expect(v).toMatchObject({ ok: false, reason: 'blocked', status: 404 });
  });

  it('refuses a decoded segment that climbs out of X into sibling root Y', () => {
    // The parser now refuses `..%2Fy%2Fsecret.txt` outright; this pins the second layer, where
    // path.join would resolve it into /work/y — inside an open root, just not the token's.
    const v = previewVerdictForRequest(req(X, '../y/secret.txt'), OPEN, file, identity);
    expect(v).toMatchObject({ ok: false, reason: 'blocked', status: 404 });
  });

  it('still serves a link inside X that resolves elsewhere inside X', () => {
    const realPath = linkTo(`${X}/alias`, `${X}/docs`);
    const v = previewVerdictForRequest(req(X, 'alias', 'a.html'), OPEN, file, realPath);
    expect(v).toMatchObject({ ok: true, path: `${X}/docs/a.html` });
  });

  it('serves a file of a nested root under whichever of the two tokens asked', () => {
    const inner = `${X}/inner`;
    const open = [X, inner];
    expect(previewVerdictForRequest(req(X, 'inner', 'a.html'), open, file, identity).ok).toBe(true);
    expect(previewVerdictForRequest(req(inner, 'a.html'), open, file, identity).ok).toBe(true);
  });

  it('refuses a token whose root is no longer open, even when an open root contains it', () => {
    const closed = `${X}/closed`;
    const v = previewVerdictForRequest(req(closed, 'a.html'), [X], file, identity);
    expect(v).toMatchObject({ ok: false, reason: 'blocked', status: 404 });
  });
});

describe('previewTargetForPath — the precheck names a root the handler will serve', () => {
  it('refuses a path inside X that resolves into open root Y rather than re-homing it', () => {
    const realPath = linkTo(`${X}/link-to-y`, Y);
    const t = previewTargetForPath(`${X}/link-to-y/page.html`, OPEN, file, realPath);
    expect(t).toMatchObject({ ok: false, reason: 'blocked', status: 404 });
  });

  it('answers with the root, and the handler agrees for that root token', () => {
    const t = previewTargetForPath(`${Y}/page.html`, OPEN, file, identity);
    expect(t).toMatchObject({ ok: true, root: Y, path: `${Y}/page.html` });
    expect(previewVerdictForRequest(req(Y, 'page.html'), OPEN, file, identity).ok).toBe(true);
  });

  it('takes the first open root that passes on its own when roots nest', () => {
    const inner = `${X}/inner`;
    // Resolves out of `inner` but stays inside X: only X may serve it.
    const realPath = linkTo(`${inner}/up`, `${X}/shared`);
    const t = previewTargetForPath(`${inner}/up/a.html`, [inner, X], file, realPath);
    expect(t).toMatchObject({ ok: true, root: X, path: `${X}/shared/a.html` });
  });

  it('refuses a path outside every open root', () => {
    const t = previewTargetForPath('/etc/passwd', OPEN, file, identity);
    expect(t).toMatchObject({
      ok: false,
      reason: 'blocked',
      detail: 'Outside the open workspace.',
    });
  });

  it('reports the refusal of the containing root, not a generic one', () => {
    const t = previewTargetForPath(`${X}/big.html`, OPEN, () => ({ kind: 'missing' }), identity);
    expect(t).toMatchObject({ ok: false, reason: 'missing' });
  });
});

describe('previewVerdictForRequest — against the real filesystem', () => {
  let base: string;
  let rx: string;
  let ry: string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-origin-')));
    rx = path.join(base, 'x');
    ry = path.join(base, 'y');
    fs.mkdirSync(rx);
    fs.mkdirSync(ry);
    fs.writeFileSync(path.join(ry, 'secret.txt'), 'y-only');
    fs.writeFileSync(path.join(rx, 'page.html'), '<p>x</p>');
    // A junction on win32 (no admin needed); the type is ignored elsewhere and a symlink is made.
    fs.symlinkSync(ry, path.join(rx, 'ylink'), 'junction');
  });

  afterAll(() => {
    fs.rmSync(path.join(rx, 'ylink'));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("serves X's own file under X's token and Y's file under Y's token", () => {
    const open = [rx, ry];
    expect(previewVerdictForRequest(req(rx, 'page.html'), open, previewStat, realPathLeaf).ok).toBe(
      true,
    );
    expect(
      previewVerdictForRequest(req(ry, 'secret.txt'), open, previewStat, realPathLeaf).ok,
    ).toBe(true);
  });

  it("refuses Y's file reached through a directory link inside X", () => {
    const v = previewVerdictForRequest(
      req(rx, 'ylink', 'secret.txt'),
      [rx, ry],
      previewStat,
      realPathLeaf,
    );
    expect(v).toMatchObject({ ok: false, reason: 'blocked', status: 404 });
    const precheck = previewTargetForPath(
      path.join(rx, 'ylink', 'secret.txt'),
      [rx, ry],
      previewStat,
      realPathLeaf,
    );
    expect(precheck).toMatchObject({ ok: false, reason: 'blocked' });
  });
});
