import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
function countingOps() {
  const real = createGitOps();
  const calls: string[] = [];
  const ops: GitServeOps = {
    repoTopLevel: (dir) => {
      calls.push('repoTopLevel');
      return real.repoTopLevel(dir);
    },
    status: (top) => {
      calls.push('status');
      return real.status(top);
    },
    diff: (abs) => {
      calls.push('diff');
      return real.diff(abs);
    },
    log: (top, opts) => {
      calls.push('log');
      return real.log(top, opts);
    },
    show: (top, sha) => {
      calls.push('show');
      return real.show(top, sha);
    },
  };
  return { ops, calls };
}

function harness(
  over: { links?: Record<string, LinkRecord>; states?: Record<string, LinkState> } = {},
) {
  const links: Record<string, LinkRecord> = over.links ?? { [CONTROLLER]: inbound(CONTROLLER) };
  const states: Record<string, LinkState> = over.states ?? {};
  const sent: LinkFrame[] = [];
  const audits: AuditEvent[] = [];
  const { ops, calls } = countingOps();
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
    const paths = res.result.snapshot.changes.map((c) => c.path);
    expect(paths).toContain('a.txt');
    expect(paths).not.toContain('.env');
    expect(res.result.snapshot.lines).toBe(true);
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
});
