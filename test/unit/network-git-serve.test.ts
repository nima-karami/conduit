import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { FS_REFUSAL_AUDIT_MS } from '../../server/network/fs-serve';
import {
  createGitOps,
  createGitServe,
  type GitServeFrame,
  type GitServeOps,
} from '../../server/network/git-serve';
import {
  type LinkFrame,
  type LinkState,
  OWN_DEFAULT_CAPABILITIES,
} from '../../src/contracts/link-protocol';
import { runGit } from '../../src/git-exec';
import type { LinkRecord } from '../../src/network/link-file';

// B serves git reads only to an inbound ssh controller, confined to a session's folders and
// deny-listed (CON-45 G1, plan decisions 1-3). Real temp repos; every git call is counted so a
// refusal can be shown to run none.

const SESSION = 's1';
const CONTROLLER = 'm-controller';
const TLS_PEER = 'm-tls';
const DIALED_PEER = 'm-dialed';

type GitRes = Extract<LinkFrame, { t: 'git.res' }>;
const isGitRes = (f: LinkFrame): f is GitRes => f.t === 'git.res';

let root: string;
let proj: string;

/** Commits through the same runner the app uses, with an identity so no global config is needed. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(
    ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args],
    {
      cwd,
    },
  );
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function initRepo(dir: string, message = 'init'): Promise<void> {
  await git(dir, 'init', '-q');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', message);
}

/** A version-2 index holding `entries` (path, blob id), checksummed as git reads it. */
function writeIndex(dir: string, entries: [string, string][]): void {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('DIRC', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const [p, id] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const name = Buffer.from(p);
    const entry = Buffer.alloc(62);
    entry.writeUInt32BE(0o100644, 24);
    entry.writeUInt32BE(3, 36);
    Buffer.from(id, 'hex').copy(entry, 40);
    entry.writeUInt16BE(name.length, 60);
    const raw = Buffer.concat([entry, name]);
    parts.push(raw, Buffer.alloc(8 - (raw.length % 8)));
  }
  const body = Buffer.concat(parts);
  fs.writeFileSync(
    path.join(dir, '.git', 'index'),
    Buffer.concat([body, createHash('sha1').update(body).digest()]),
  );
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'git-serve-')));
  proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(proj, '.env'), 'TOKEN=1\n');
  fs.mkdirSync(path.join(proj, '.ssh'));
  fs.writeFileSync(path.join(proj, '.ssh', 'id'), 'key\n');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'secret\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const inbound = (machineId: string): LinkRecord => ({
  linkId: `l-${machineId}`,
  machineId,
  serverKey: 'k',
  ownerKey: null,
  name: machineId,
  trust: 'own',
  addresses: [],
  capabilities: { ...OWN_DEFAULT_CAPABILITIES },
  fingerprint: '',
  createdAt: '2026-11-16T00:00:00.000Z',
  cert: '',
  ownerTransfer: null,
  transport: 'ssh',
  ssh: null,
  machine: null,
});

const dialed = (machineId: string): LinkRecord => ({
  ...inbound(machineId),
  ssh: { target: 'b-host', node: 'node', mainJs: 'main.js', userData: '/ud' },
});

const tlsLink = (machineId: string): LinkRecord => ({ ...inbound(machineId), transport: 'tls' });

/** The production git reads, each wrapped so a test can see whether git ran at all. */
function countingOps(over: Partial<GitServeOps> = {}) {
  const real = createGitOps();
  const calls: string[] = [];
  const ops: GitServeOps = {
    repoTopLevel: (dir) => {
      calls.push('repoTopLevel');
      return (over.repoTopLevel ?? real.repoTopLevel)(dir);
    },
    absoluteGitDir: (dir) => {
      calls.push('absoluteGitDir');
      return (over.absoluteGitDir ?? real.absoluteGitDir)(dir);
    },
    gitCommonDir: (dir) => {
      calls.push('gitCommonDir');
      return (over.gitCommonDir ?? real.gitCommonDir)(dir);
    },
    status: (top) => {
      calls.push('status');
      return (over.status ?? real.status)(top);
    },
    diff: (top, abs) => {
      calls.push('diff');
      return (over.diff ?? real.diff)(top, abs);
    },
    log: (top, opts) => {
      calls.push('log');
      return (over.log ?? real.log)(top, opts);
    },
    show: (top, sha) => {
      calls.push('show');
      return (over.show ?? real.show)(top, sha);
    },
  };
  return { ops, calls };
}

function harness(
  over: {
    links?: Record<string, LinkRecord>;
    states?: Record<string, LinkState>;
    git?: Partial<GitServeOps>;
  } = {},
) {
  const links: Record<string, LinkRecord> = over.links ?? { [CONTROLLER]: inbound(CONTROLLER) };
  const states: Record<string, LinkState> = over.states ?? {};
  const sent: LinkFrame[] = [];
  const audits: AuditEvent[] = [];
  const { ops, calls } = countingOps(over.git);
  let at = 1_000_000;
  const serve = createGitServe({
    linkOf: (machineId) => links[machineId] ?? null,
    linkState: (machineId) => states[machineId] ?? 'up',
    sessionRoots: (sessionId) => (sessionId === SESSION ? [proj] : null),
    git: ops,
    send: (_machineId, frame) => {
      sent.push(frame);
    },
    audit: { record: (e) => audits.push(e) },
    now: () => at,
  });
  return {
    serve,
    sent,
    audits,
    calls,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const req = (
  id: string,
  op: GitServeFrame['op'],
  args: GitServeFrame['args'],
  folder: string = proj,
  sessionId: string = SESSION,
): GitServeFrame => ({ t: 'git.req', id, op, sessionId, root: folder, args });

const replyTo = (sent: LinkFrame[], id: string): GitRes => {
  const found = sent.filter(isGitRes).find((f) => f.id === id);
  if (!found) throw new Error(`no git.res for ${id}`);
  return found;
};

describe('git-serve', () => {
  it('status lists changes in the session repo and omits denied paths', async () => {
    await initRepo(proj);
    fs.writeFileSync(path.join(proj, 'a.txt'), 'hello there\n');
    fs.writeFileSync(path.join(proj, '.env'), 'TOKEN=2\n');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('r1', 'status', {}));
    const res = replyTo(h.sent, 'r1');
    expect(res.ok).toBe(true);
    if (!res.ok || res.result.op !== 'status') throw new Error('expected a status result');
    const snapshot = res.result.snapshot;
    if (snapshot === null) throw new Error('expected a status snapshot');
    const paths = snapshot.changes.map((c) => c.path);
    expect(paths).toContain('a.txt');
    expect(paths).not.toContain('.env');
    expect(snapshot.lines).toBe(true);
  });

  it('a root outside the session folders is refused and git never runs', async () => {
    await initRepo(proj);
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('r2', 'status', {}, root));
    const res = replyTo(h.sent, 'r2');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error.code).toBe('refused');
    expect(h.calls).toEqual([]);
  });

  it('a repo whose top level is above the session folder is refused', async () => {
    await initRepo(root, 'outer');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('r3', 'status', {}));
    const res = replyTo(h.sent, 'r3');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error.code).toBe('refused');
    expect(h.calls).not.toContain('status');
    expect(h.audits.map((a) => a.detail?.reason)).toEqual(['repo_outside_session']);
  });

  it('diff of a denied path is refused', async () => {
    await initRepo(proj);
    fs.writeFileSync(path.join(proj, '.env'), 'TOKEN=secret-changed\n');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('r4', 'diff', { path: path.join(proj, '.env') }));
    const res = replyTo(h.sent, 'r4');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error.code).toBe('refused');
    expect(res.error.message).not.toContain('secret-changed');
    expect(h.calls).not.toContain('diff');
  });

  it('log returns commits with lanes', async () => {
    await initRepo(proj, 'first');
    fs.writeFileSync(path.join(proj, 'a.txt'), 'second\n');
    await git(proj, 'commit', '-qam', 'second');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('r5', 'log', {}));
    const res = replyTo(h.sent, 'r5');
    expect(res.ok).toBe(true);
    if (!res.ok || res.result.op !== 'log') throw new Error('expected a log result');
    expect(res.result.commits.map((c) => c.sha)).toHaveLength(2);
    expect(res.result.layout.rows).toHaveLength(2);
    expect(res.result.state).toBe('ok');
    expect(res.result.hasMore).toBe(false);
  });

  it('show of a commit drops denied files', async () => {
    await initRepo(proj, 'first');
    fs.writeFileSync(path.join(proj, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(proj, '.env'), 'TOKEN=3\n');
    await git(proj, 'commit', '-qam', 'touch both');
    const sha = await git(proj, 'rev-parse', 'HEAD');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('r6', 'show', { sha }));
    const res = replyTo(h.sent, 'r6');
    expect(res.ok).toBe(true);
    if (!res.ok || res.result.op !== 'show') throw new Error('expected a show result');
    const paths = res.result.files.map((f) => f.path);
    expect(paths).toContain('a.txt');
    expect(paths).not.toContain('.env');
  });

  it('refuses git.req from a TLS link and from an A-side dialed record, and audits once per minute', async () => {
    await initRepo(proj);
    const h = harness({
      links: { [TLS_PEER]: tlsLink(TLS_PEER), [DIALED_PEER]: dialed(DIALED_PEER) },
    });
    await h.serve.onFrame(TLS_PEER, req('t1', 'status', {}));
    await h.serve.onFrame(TLS_PEER, req('t2', 'status', {}));
    await h.serve.onFrame(DIALED_PEER, req('d1', 'log', {}));
    for (const id of ['t1', 't2', 'd1']) {
      const res = replyTo(h.sent, id);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected a refusal');
      expect(res.error.code).toBe('refused');
    }
    expect(h.calls).toEqual([]);
    // One audit per link in the first window: the second TLS request is inside it.
    expect(h.audits.map((a) => a.peer)).toEqual([TLS_PEER, DIALED_PEER]);
    h.advance(FS_REFUSAL_AUDIT_MS);
    await h.serve.onFrame(TLS_PEER, req('t3', 'status', {}));
    expect(h.audits.map((a) => a.peer)).toEqual([TLS_PEER, DIALED_PEER, TLS_PEER]);
  });

  it('unknown session is not_found', async () => {
    await initRepo(proj);
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('r8', 'status', {}, proj, 'no-such-session'));
    const res = replyTo(h.sent, 'r8');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected an error');
    expect(res.error.code).toBe('not_found');
    expect(h.calls).toEqual([]);
  });

  it('diff of a deleted file returns its diff', async () => {
    await initRepo(proj);
    fs.rmSync(path.join(proj, 'a.txt'));
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('r9', 'diff', { path: path.join(proj, 'a.txt') }));
    const res = replyTo(h.sent, 'r9');
    expect(res.ok).toBe(true);
    if (!res.ok || res.result.op !== 'diff') throw new Error('expected a diff result');
    expect(res.result.file.head).toBe('hello\n');
    expect(res.result.file.work).toBe('');
    expect(res.result.file.error).toBeUndefined();
  });

  it('a folder in no repo answers status with snapshot null', async () => {
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('n1', 'status', {}));
    expect(replyTo(h.sent, 'n1')).toEqual({
      t: 'git.res',
      id: 'n1',
      ok: true,
      result: { op: 'status', root: proj, snapshot: null },
    });
    await h.serve.onFrame(CONTROLLER, req('n2', 'log', {}));
    const log = replyTo(h.sent, 'n2');
    expect(log.ok).toBe(false);
  });

  it('show drops a file renamed out of a denied name', async () => {
    await initRepo(proj, 'first');
    await git(proj, 'mv', '.env', 'config.txt');
    await git(proj, 'mv', 'a.txt', 'b.txt');
    await git(proj, 'commit', '-qm', 'rename both');
    const sha = await git(proj, 'rev-parse', 'HEAD');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('rn1', 'show', { sha }));
    const res = replyTo(h.sent, 'rn1');
    expect(res.ok).toBe(true);
    if (!res.ok || res.result.op !== 'show') throw new Error('expected a show result');
    const paths = res.result.files.map((f) => f.path);
    expect(paths).toContain('b.txt');
    expect(paths).not.toContain('config.txt');
    expect(JSON.stringify(res.result)).not.toContain('TOKEN=1');
  });

  it('status drops a rename out of a denied name', async () => {
    await initRepo(proj, 'first');
    await git(proj, 'mv', '.env', 'config.txt');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('rn2', 'status', {}));
    const res = replyTo(h.sent, 'rn2');
    expect(res.ok).toBe(true);
    if (!res.ok || res.result.op !== 'status') throw new Error('expected a status result');
    const snapshot = res.result.snapshot;
    if (snapshot === null) throw new Error('expected a status snapshot');
    const paths = snapshot.changes.map((c) => c.path);
    expect(paths).not.toContain('config.txt');
    expect(paths).not.toContain('.env');
  });

  it('a .git file pointing outside the roots is refused for log and diff', async () => {
    const secret = path.join(root, 'secret');
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, 's.txt'), 'TOPSECRET\n');
    await initRepo(secret, 'secret commit');
    // The session folder holds the file too, so the diff is of a real file in a session folder.
    fs.writeFileSync(path.join(proj, 's.txt'), 'TOPSECRET\n');
    fs.writeFileSync(path.join(proj, '.git'), `gitdir: ${path.join(secret, '.git')}\n`);
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('g1', 'log', {}));
    await h.serve.onFrame(CONTROLLER, req('g2', 'diff', { path: path.join(proj, 's.txt') }));
    const secretSha = await git(secret, 'rev-parse', 'HEAD');
    await h.serve.onFrame(CONTROLLER, req('g3', 'show', { sha: secretSha }));
    for (const id of ['g1', 'g2', 'g3']) {
      const res = replyTo(h.sent, id);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected a refusal');
      expect(res.error.code).toBe('refused');
    }
    expect(JSON.stringify(h.sent)).not.toContain('TOPSECRET');
    expect(h.calls).not.toContain('log');
    expect(h.calls).not.toContain('diff');
    expect(h.calls).not.toContain('show');
  });

  it('a real git worktree whose common dir is outside is still served', async () => {
    const main = path.join(root, 'main');
    fs.mkdirSync(main);
    fs.writeFileSync(path.join(main, 'm.txt'), 'main\n');
    await initRepo(main, 'main commit');
    // The session folder becomes a linked worktree of a repo that lives outside the session.
    fs.rmSync(proj, { recursive: true, force: true });
    await git(main, 'worktree', 'add', '-q', proj, '-b', 'wt');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('w1', 'log', {}));
    const res = replyTo(h.sent, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok || res.result.op !== 'log') throw new Error('expected a log result');
    expect(res.result.commits).toHaveLength(1);
  });

  describe('a git dir inside the session that reaches outside through its contents', () => {
    let secret: string;
    let secretSha: string;
    beforeEach(async () => {
      secret = path.join(root, 'secret');
      fs.mkdirSync(secret);
      fs.writeFileSync(path.join(secret, 's.txt'), 'TOPSECRET\n');
      await initRepo(secret, 'secret commit');
      secretSha = await git(secret, 'rev-parse', 'HEAD');
      await initRepo(proj);
    });

    /** Asks for the outside commit and its history and expects both refused before git reads. */
    async function expectRefused(): Promise<void> {
      const h = harness();
      await h.serve.onFrame(CONTROLLER, req('x1', 'show', { sha: secretSha }));
      await h.serve.onFrame(CONTROLLER, req('x2', 'log', {}));
      for (const id of ['x1', 'x2']) {
        const res = replyTo(h.sent, id);
        if (res.ok) throw new Error(`expected ${id} refused`);
        expect(res.error.code).toBe('refused');
      }
      expect(JSON.stringify(h.sent)).not.toContain('TOPSECRET');
      expect(h.calls).not.toContain('show');
      expect(h.calls).not.toContain('log');
      expect(h.audits.map((a) => a.detail)).toContainEqual({ reason: 'git_dir_outside' });
    }

    it('objects symlinked to an outside repo is refused', async () => {
      const objects = path.join(proj, '.git', 'objects');
      fs.rmSync(objects, { recursive: true, force: true });
      fs.symlinkSync(path.join(secret, '.git', 'objects'), objects);
      await expectRefused();
    });

    it('a loose object symlinked to an outside one is refused', async () => {
      const from = path.join(secret, '.git', 'objects');
      for (const dir of fs.readdirSync(from).filter((d) => /^[0-9a-f]{2}$/.test(d))) {
        fs.mkdirSync(path.join(proj, '.git', 'objects', dir), { recursive: true });
        for (const file of fs.readdirSync(path.join(from, dir))) {
          const link = path.join(proj, '.git', 'objects', dir, file);
          if (!fs.existsSync(link)) fs.symlinkSync(path.join(from, dir, file), link);
        }
      }
      await expectRefused();
    });

    it('an alternates file naming an outside object store is refused', async () => {
      fs.writeFileSync(
        path.join(proj, '.git', 'objects', 'info', 'alternates'),
        `${path.join(secret, '.git', 'objects')}\n`,
      );
      await expectRefused();
    });

    it('a dangling symlink in the git dir is refused', async () => {
      fs.symlinkSync(path.join(root, 'not-yet'), path.join(proj, '.git', 'later'));
      await expectRefused();
    });

    it('a symlink that stays inside the session is still served', async () => {
      fs.symlinkSync(path.join(proj, 'a.txt'), path.join(proj, '.git', 'inside-link'));
      const h = harness();
      await h.serve.onFrame(CONTROLLER, req('i1', 'log', {}));
      const res = replyTo(h.sent, 'i1');
      expect(res.ok).toBe(true);
    });
  });

  it('a core.worktree set after a first status moves the top outside and is refused', async () => {
    await initRepo(proj);
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('t1', 'status', {}));
    expect(replyTo(h.sent, 't1').ok).toBe(true);
    await git(proj, 'config', 'core.worktree', root);
    await h.serve.onFrame(CONTROLLER, req('t2', 'status', {}));
    const res = replyTo(h.sent, 't2');
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error.code).toBe('refused');
    expect(JSON.stringify(h.sent)).not.toContain('outside.txt');
  });

  describe('config that would run a program during a read', () => {
    let marker: string;
    beforeEach(async () => {
      marker = path.join(root, 'ran.txt');
      fs.writeFileSync(path.join(proj, 'big.bin'), 'pointer\n');
      fs.writeFileSync(
        path.join(proj, '.gitattributes'),
        '*.bin filter=lfs diff=lfs\n*.txt diff=conv\n',
      );
      await initRepo(proj);
      // An LFS-style setup, plus every other key the re-review showed running code on B.
      const run = (tag: string) => `sh -c 'echo ${tag} >> "${marker}"; cat'`;
      await git(proj, 'config', 'filter.lfs.clean', run('clean'));
      await git(proj, 'config', 'filter.lfs.smudge', run('smudge'));
      await git(proj, 'config', 'filter.lfs.process', run('process'));
      await git(proj, 'config', 'filter.lfs.required', 'true');
      await git(proj, 'config', 'diff.conv.textconv', run('textconv'));
      await git(proj, 'config', 'core.fsmonitor', run('fsmonitor'));
      await git(proj, 'config', 'log.showSignature', 'true');
      await git(proj, 'config', 'gpg.program', run('gpg'));
      fs.writeFileSync(marker, '');
      fs.appendFileSync(path.join(proj, 'big.bin'), 'more\n');
      fs.appendFileSync(path.join(proj, 'a.txt'), 'more\n');
    });

    it('status, diff, log and show still answer and nothing runs', async () => {
      const sha = await git(proj, 'rev-parse', 'HEAD');
      const h = harness();
      await h.serve.onFrame(CONTROLLER, req('c1', 'status', {}));
      await h.serve.onFrame(CONTROLLER, req('c2', 'diff', { path: path.join(proj, 'a.txt') }));
      await h.serve.onFrame(CONTROLLER, req('c3', 'log', {}));
      await h.serve.onFrame(CONTROLLER, req('c4', 'show', { sha }));
      const status = replyTo(h.sent, 'c1');
      if (!status.ok || status.result.op !== 'status' || status.result.snapshot === null)
        throw new Error('expected a status');
      expect(status.result.snapshot.changes.map((c) => c.path).sort()).toEqual([
        'a.txt',
        'big.bin',
      ]);
      for (const id of ['c2', 'c3', 'c4']) expect(replyTo(h.sent, id).ok).toBe(true);
      expect(fs.readFileSync(marker, 'utf8')).toBe('');
    });
  });

  it("a submodule's own filter never runs during a served status", async () => {
    const marker = path.join(root, 'sub-ran.txt');
    const sub = path.join(proj, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'f'), 'one\n');
    await initRepo(sub);
    await initRepo(proj);
    const subHead = await git(sub, 'rev-parse', 'HEAD');
    await git(proj, 'update-index', '--add', '--cacheinfo', `160000,${subHead},sub`);
    // The submodule's config and attributes are its own; the superproject's listing never sees them.
    fs.writeFileSync(path.join(sub, '.git', 'info', 'attributes'), '* filter=q\n');
    await git(sub, 'config', 'filter.q.clean', `sh -c 'echo ran >> "${marker}"; cat'`);
    fs.writeFileSync(marker, '');
    fs.writeFileSync(path.join(sub, 'f'), 'two\n');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('s1', 'status', {}));
    expect(replyTo(h.sent, 's1').ok).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('');
  });

  it('show never reads an LFS object from an lfs.storage outside the repo', async () => {
    const bytes = Buffer.from('OUTSIDE-LFS-IMAGE-BYTES');
    const oid = createHash('sha256').update(bytes).digest('hex');
    const store = path.join(root, 'lfsstore', 'objects', oid.slice(0, 2), oid.slice(2, 4));
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, oid), bytes);
    await initRepo(proj);
    fs.writeFileSync(
      path.join(proj, 'pic.png'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`,
    );
    await git(proj, 'add', 'pic.png');
    await git(proj, 'commit', '-qm', 'pic');
    await git(proj, 'config', 'lfs.storage', path.join(root, 'lfsstore'));
    const sha = await git(proj, 'rev-parse', 'HEAD');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('p1', 'show', { sha }));
    expect(replyTo(h.sent, 'p1').ok).toBe(true);
    expect(JSON.stringify(h.sent)).not.toContain(bytes.toString('base64'));
  });

  it('an index entry naming a path outside the top never reaches status', async () => {
    await initRepo(proj);
    fs.writeFileSync(path.join(root, 'pw.txt'), 'user=alice\npassword=hunter2\n');
    const rel = path.relative(proj, path.join(root, 'pw.txt'));
    const kept = await git(proj, 'rev-parse', 'HEAD:a.txt');
    const blob = await runGit(['hash-object', '-w', '--stdin'], {
      cwd: proj,
      stdin: 'user=alice\npassword=hunter2\n',
    });
    if (!blob.ok) throw new Error('hash-object failed');
    // git itself refuses to stage such a path, so the index is written by hand, as a writer could.
    writeIndex(proj, [
      ['a.txt', kept],
      [rel, blob.stdout.trim()],
    ]);
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('n1', 'status', {}));
    const res = replyTo(h.sent, 'n1');
    if (!res.ok || res.result.op !== 'status' || res.result.snapshot === null)
      throw new Error('expected a status');
    expect(res.result.snapshot.changes.map((c) => c.path)).not.toContain(rel);
  });

  it('a line count never follows a symlinked folder out of the repo', async () => {
    await initRepo(proj);
    const away = path.join(root, 'away');
    fs.mkdirSync(away);
    fs.writeFileSync(path.join(away, 'pw.txt'), '1\n2\n3\n4\n5\n6\n7\n');
    fs.symlinkSync(away, path.join(proj, 'link'));
    const kept = await git(proj, 'rev-parse', 'HEAD:a.txt');
    const blob = await runGit(['hash-object', '-w', '--stdin'], { cwd: proj, stdin: 'x\ny\nz\n' });
    if (!blob.ok) throw new Error('hash-object failed');
    writeIndex(proj, [
      ['a.txt', kept],
      ['link/pw.txt', blob.stdout.trim()],
    ]);
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('y1', 'status', {}));
    const res = replyTo(h.sent, 'y1');
    if (!res.ok || res.result.op !== 'status' || res.result.snapshot === null)
      throw new Error('expected a status');
    for (const c of res.result.snapshot.changes) expect(c.added).not.toBe(7);
  });

  it('show names no path outside the top, even from a tree entry named ..', async () => {
    await initRepo(proj);
    const blob = await git(proj, 'rev-parse', 'HEAD:a.txt');
    const inner = await runGit(['mktree'], {
      cwd: proj,
      stdin: `100644 blob ${blob}\tsecret.txt\n`,
    });
    if (!inner.ok) throw new Error('mktree failed');
    const outer = await runGit(['mktree'], {
      cwd: proj,
      stdin: `040000 tree ${inner.stdout.trim()}\t..\n`,
    });
    if (!outer.ok) throw new Error('mktree failed');
    const crafted = await git(proj, 'commit-tree', outer.stdout.trim(), '-m', 'x');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('z1', 'show', { sha: crafted }));
    const res = replyTo(h.sent, 'z1');
    if (!res.ok || res.result.op !== 'show') throw new Error('expected a show result');
    expect(res.result.files.map((f) => f.path)).toEqual([]);
  });

  it('a repo extension that could fetch or run something is refused before any read', async () => {
    await initRepo(proj);
    await git(proj, 'config', 'core.repositoryformatversion', '1');
    await git(proj, 'config', 'extensions.partialClone', 'origin');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('e1', 'log', {}));
    const res = replyTo(h.sent, 'e1');
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error.code).toBe('refused');
    expect(h.calls).not.toContain('log');
  });

  it("show hides a denied file's blob under a harmless name", async () => {
    await initRepo(proj);
    const envBlob = await git(proj, 'rev-parse', 'HEAD:.env');
    const tree = await runGit(['mktree'], {
      cwd: proj,
      stdin: `100644 blob ${envBlob}\tinnocent.txt\n`,
    });
    if (!tree.ok) throw new Error('mktree failed');
    // A root commit, so rename detection can't pair it with `.env` and the name filter can't help.
    const crafted = await git(proj, 'commit-tree', tree.stdout.trim(), '-m', 'x');
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('b1', 'show', { sha: crafted }));
    const res = replyTo(h.sent, 'b1');
    if (!res.ok || res.result.op !== 'show') throw new Error('expected a show result');
    expect(res.result.files.map((f) => f.path)).not.toContain('innocent.txt');
    expect(JSON.stringify(h.sent)).not.toContain('TOKEN=1');
  });

  it('an untracked symlink counts as git stores it, never as the file it points at', async () => {
    await initRepo(proj);
    fs.writeFileSync(path.join(root, 'many.txt'), 'a\nb\nc\nd\n');
    fs.symlinkSync(path.join(root, 'many.txt'), path.join(proj, 'l'));
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('l1', 'status', {}));
    const res = replyTo(h.sent, 'l1');
    if (!res.ok || res.result.op !== 'status' || res.result.snapshot === null)
      throw new Error('expected a status');
    const link = res.result.snapshot.changes.find((c) => c.path === 'l');
    expect(link?.added).toBe(1);
  });

  describe('the git-dir check is reused only while nothing in it changed (security review M4)', () => {
    let secret: string;
    let secretSha: string;
    beforeEach(async () => {
      secret = path.join(root, 'secret');
      fs.mkdirSync(secret);
      fs.writeFileSync(path.join(secret, 's.txt'), 'TOPSECRET\n');
      await initRepo(secret, 'secret commit');
      secretSha = await git(secret, 'rev-parse', 'HEAD');
      await initRepo(proj);
    });

    const readdirCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter((c) => String(c[0]).includes(`${path.sep}.git`)).length;

    it('a second read of an unchanged repo does not walk its git dir again', async () => {
      const spy = vi.spyOn(fs.promises, 'readdir');
      try {
        const h = harness();
        await h.serve.onFrame(CONTROLLER, req('m1', 'status', {}));
        const first = readdirCalls(spy);
        expect(first).toBeGreaterThan(0);
        await h.serve.onFrame(CONTROLLER, req('m2', 'status', {}));
        expect(readdirCalls(spy)).toBe(first);
        expect(replyTo(h.sent, 'm2').ok).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('a link planted in an existing objects folder after a clean check is refused', async () => {
      const h = harness();
      await h.serve.onFrame(CONTROLLER, req('p1', 'status', {}));
      expect(replyTo(h.sent, 'p1').ok).toBe(true);
      // Into a folder that already exists: only that folder's mtime moves, not objects/.
      const objects = path.join(proj, '.git', 'objects');
      const existing = fs.readdirSync(objects).find((d) => /^[0-9a-f]{2}$/.test(d));
      if (existing === undefined) throw new Error('no loose object folder');
      fs.symlinkSync(path.join(root, 'outside.txt'), path.join(objects, existing, 'zz-planted'));
      await h.serve.onFrame(CONTROLLER, req('p2', 'log', {}));
      const res = replyTo(h.sent, 'p2');
      if (res.ok) throw new Error('expected a refusal');
      expect(res.error.code).toBe('refused');
    });

    it('an alternates file written after a clean check is refused', async () => {
      const h = harness();
      await h.serve.onFrame(CONTROLLER, req('a1', 'status', {}));
      expect(replyTo(h.sent, 'a1').ok).toBe(true);
      fs.writeFileSync(
        path.join(proj, '.git', 'objects', 'info', 'alternates'),
        `${path.join(secret, '.git', 'objects')}\n`,
      );
      await h.serve.onFrame(CONTROLLER, req('a2', 'show', { sha: secretSha }));
      const res = replyTo(h.sent, 'a2');
      if (res.ok) throw new Error('expected a refusal');
      expect(res.error.code).toBe('refused');
    });

    it('a git dir holding a link is walked every time', async () => {
      fs.symlinkSync(path.join(proj, 'a.txt'), path.join(proj, '.git', 'inside-link'));
      const spy = vi.spyOn(fs.promises, 'readdir');
      try {
        const h = harness();
        await h.serve.onFrame(CONTROLLER, req('w1', 'status', {}));
        const first = readdirCalls(spy);
        await h.serve.onFrame(CONTROLLER, req('w2', 'status', {}));
        expect(readdirCalls(spy)).toBeGreaterThan(first);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('a result over 8 MiB is too_large', async () => {
    await initRepo(proj);
    const huge = 'x'.repeat(9 * 1024 * 1024);
    const h = harness({
      git: {
        status: async () => ({
          ok: true,
          changes: [{ path: huge, added: 0, removed: 0, kind: 'M', staged: false }],
          trackedDirty: true,
        }),
      },
    });
    await h.serve.onFrame(CONTROLLER, req('big', 'status', {}));
    const res = replyTo(h.sent, 'big');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected an error');
    expect(res.error.code).toBe('too_large');
  });

  it('a diff read error never reaches the peer', async () => {
    await initRepo(proj);
    const h = harness({
      git: {
        diff: async (_top, abs) => ({
          path: abs,
          head: '',
          work: '',
          binary: false,
          error: 'LEAK-4242 /secret/content',
        }),
      },
    });
    await h.serve.onFrame(CONTROLLER, req('de', 'diff', { path: path.join(proj, 'a.txt') }));
    const res = replyTo(h.sent, 'de');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected an error');
    expect(res.error.code).toBe('failed');
    expect(JSON.stringify(res)).not.toContain('LEAK-4242');
  });

  it('diff path outside the checked top is refused', async () => {
    // The repo is a sub-folder; a file of the session folder that is outside that repo is named.
    const sub = path.join(proj, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 's.txt'), 'sub\n');
    await initRepo(sub);
    const h = harness();
    await h.serve.onFrame(CONTROLLER, req('op', 'diff', { path: path.join(proj, 'a.txt') }, sub));
    const res = replyTo(h.sent, 'op');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error.code).toBe('refused');
    expect(h.calls).not.toContain('diff');
  });
});
