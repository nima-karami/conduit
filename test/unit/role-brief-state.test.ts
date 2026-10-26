import { describe, expect, it } from 'vitest';
import { BRIEF_MAX_BYTES } from '../../src/role-brief';
import {
  type BriefAction,
  type BriefDialogState,
  briefRequestOf,
  briefStartBlock,
  initialBriefState,
  reduceBrief,
} from '../../webview/role-brief-state';
import { BRIEF_STR } from '../../webview/role-brief-strings';

const run = (actions: BriefAction[], from = initialBriefState()): BriefDialogState =>
  actions.reduce(reduceBrief, from);
const supported = (over: Partial<Extract<BriefAction, { type: 'agentPreviewed' }>> = {}) =>
  ({ type: 'agentPreviewed', supported: true, has: false, ...over }) as const;

describe('reduceBrief', () => {
  it('starts unsupported on None', () => {
    expect(initialBriefState()).toMatchObject({ supported: false, mode: 'none', agentHas: false });
  });

  it('a launcher change resets the mode and the support flag', () => {
    const s = run([supported(), { type: 'setMode', mode: 'text' }, { type: 'launcherChanged' }]);
    expect(s).toEqual(initialBriefState());
  });

  it('agentPreviewed with has selects the agent mode', () => {
    const s = run([supported({ has: true, firstLine: 'You are a reviewer', path: '/a/b.md' })]);
    expect(s).toMatchObject({
      supported: true,
      agentHas: true,
      mode: 'agent',
      agentFirstLine: 'You are a reviewer',
      agentPath: '/a/b.md',
    });
  });

  it('agentPreviewed without a brief keeps None', () => {
    expect(run([supported()]).mode).toBe('none');
  });

  it('agentPreviewed does not override a mode the user already picked', () => {
    const s = run([{ type: 'setMode', mode: 'text' }, supported({ has: true })]);
    expect(s.mode).toBe('text');
  });

  it('a file path change goes to checking and a probe reply settles it', () => {
    const typed = run([
      { type: 'setMode', mode: 'file' },
      { type: 'setPath', path: '/x.md' },
    ]);
    expect(typed.probe).toEqual({ phase: 'checking' });
    expect(reduceBrief(typed, { type: 'probed', ok: true, bytes: 12 }).probe).toEqual({
      phase: 'ok',
      bytes: 12,
    });
    expect(reduceBrief(typed, { type: 'probed', ok: false, error: 'brief-invalid' }).probe).toEqual(
      { phase: 'error', error: 'brief-invalid' },
    );
  });

  it('clearing the path returns the probe to idle', () => {
    const s = run([
      { type: 'setPath', path: '/x.md' },
      { type: 'setPath', path: '  ' },
    ]);
    expect(s.probe).toEqual({ phase: 'idle' });
  });
});

describe('briefStartBlock', () => {
  const text = (t: string) =>
    run([supported(), { type: 'setMode', mode: 'text' }, { type: 'setText', text: t }]);
  const file = (...a: BriefAction[]) => run([supported(), { type: 'setMode', mode: 'file' }, ...a]);

  it('never blocks an unsupported launcher', () => {
    expect(briefStartBlock(initialBriefState(), '%')).toBeNull();
  });

  it('never blocks None', () => {
    expect(briefStartBlock(run([supported()]), '%')).toBeNull();
  });

  it('blocks over-cap text with the too-large copy', () => {
    const over = 'a'.repeat(BRIEF_MAX_BYTES + 1);
    expect(briefStartBlock(text(over), undefined)).toEqual({
      reason: BRIEF_STR.errors['brief-too-large'],
    });
    expect(briefStartBlock(text('a'.repeat(BRIEF_MAX_BYTES)), undefined)).toBeNull();
  });

  it('blocks empty text and an empty file path', () => {
    expect(briefStartBlock(text('  \n'), undefined)).toEqual({ reason: BRIEF_STR.emptyText });
    expect(briefStartBlock(file(), undefined)).toEqual({ reason: BRIEF_STR.emptyFile });
  });

  it('blocks on a host briefBlocked metachar', () => {
    expect(briefStartBlock(text('hi'), '%')).toEqual({ reason: BRIEF_STR.blocked('%') });
  });

  it('blocks while the file probe runs and on a probe error', () => {
    const checking = file({ type: 'setPath', path: '/x.md' });
    expect(briefStartBlock(checking, undefined)).toEqual({ reason: BRIEF_STR.checking });
    const bad = reduceBrief(checking, { type: 'probed', ok: false, error: 'brief-unreadable' });
    expect(briefStartBlock(bad, undefined)).toEqual({
      reason: BRIEF_STR.errors['brief-unreadable'],
    });
    const good = reduceBrief(checking, { type: 'probed', ok: true, bytes: 3 });
    expect(briefStartBlock(good, undefined)).toBeNull();
  });

  it('blocks the agent mode on an agent brief error', () => {
    const s = run([supported({ has: true, error: 'brief-invalid' })]);
    expect(briefStartBlock(s, undefined)).toEqual({ reason: BRIEF_STR.errors['brief-invalid'] });
  });
});

describe('briefRequestOf', () => {
  it('maps each mode', () => {
    const base = run([supported({ has: true })]);
    expect(briefRequestOf(base)).toEqual({ kind: 'agent' });
    expect(briefRequestOf(reduceBrief(base, { type: 'setMode', mode: 'none' }))).toEqual({
      kind: 'none',
    });
    const t = run(
      [
        { type: 'setMode', mode: 'text' },
        { type: 'setText', text: 'hi' },
      ],
      base,
    );
    expect(briefRequestOf(t)).toEqual({ kind: 'text', text: 'hi' });
    const f = run(
      [
        { type: 'setMode', mode: 'file' },
        { type: 'setPath', path: ' /x.md ' },
      ],
      base,
    );
    expect(briefRequestOf(f)).toEqual({ kind: 'file', path: '/x.md' });
  });

  it('is undefined for an unsupported launcher', () => {
    expect(briefRequestOf(initialBriefState())).toBeUndefined();
  });
});

describe('BRIEF_STR.count', () => {
  it('formats KiB with one decimal', () => {
    expect(BRIEF_STR.count(100)).toBe('0.1 / 64 KiB');
    expect(BRIEF_STR.count(0)).toBe('0 / 64 KiB');
  });
});
