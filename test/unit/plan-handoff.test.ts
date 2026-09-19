import { describe, expect, it } from 'vitest';
import { type PlanBlock, splitPlan } from '../../src/plan-blocks';
import type { AnchoredComment, PlanComment } from '../../src/plan-comments';
import { buildPlanHandoff, type PlanHandoffInput } from '../../src/plan-handoff';

const PLAN = [
  'The identity service owns accounts.',
  '',
  '```mermaid',
  'flowchart LR',
  '  txn --> identity',
  '```',
  '',
  '```ts',
  'export function createIdentity(): string;',
  '```',
].join('\n');

const { blocks } = splitPlan(PLAN);
const [prose, diagram, code] = blocks;

const PLAN_PATH = '.conduit/plans/identity.md';

function comment(over: Partial<PlanComment> = {}): PlanComment {
  return {
    id: 'c1',
    author: 'human',
    text: 'This should not talk to identity directly.',
    anchor: { index: 1, hash: diagram.hash, snippet: diagram.snippet },
    status: 'open',
    createdAt: '2026-09-19T10:00:00.000Z',
    ...over,
  };
}

function anchored(index: number | null, over: Partial<PlanComment> = {}): AnchoredComment {
  return { comment: comment(over), index };
}

function build(over: Partial<PlanHandoffInput> = {}): string {
  return buildPlanHandoff({
    planPath: PLAN_PATH,
    changed: [],
    removed: 0,
    comments: [],
    blocks,
    ...over,
  });
}

describe('buildPlanHandoff', () => {
  it('opens with the plan path and closes with the revise instruction', () => {
    const lines = build().split('\n');
    expect(lines[0]).toBe(`Plan: ${PLAN_PATH} — I edited it and left comments.`);
    expect(lines[lines.length - 1]).toBe(
      'Please revise the plan file, reply to each comment in .conduit/plans/identity.comments.json, and tell me what you changed.',
    );
  });

  it('no trailing newline', () => {
    const out = build({ changed: [diagram], comments: [anchored(1)], removed: 2 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.endsWith('\n')).toBe(false);
    expect(out.endsWith(' ')).toBe(false);
  });

  it('prints both section headers even when empty', () => {
    const out = build();
    expect(out).toContain('Changed blocks (0):');
    expect(out).toContain('Open comments (0):');
  });

  it('changed diagram block is fenced verbatim', () => {
    const out = build({ changed: [diagram] });
    expect(out).toContain(
      [
        'Changed blocks (1):',
        '- §2 diagram:',
        '```mermaid',
        'flowchart LR',
        '  txn --> identity',
        '```',
      ].join('\n'),
    );
  });

  it('changed code block names its language and is fenced verbatim', () => {
    const out = build({ changed: [code] });
    expect(out).toContain(
      ['- §3 code (ts):', '```ts', 'export function createIdentity(): string;', '```'].join('\n'),
    );
  });

  it('a code block with no language is labelled without a language', () => {
    const noLang: PlanBlock = { ...code, lang: null };
    expect(build({ changed: [noLang] })).toContain('- §3 code:');
  });

  it('prose block is pasted as text', () => {
    const out = build({ changed: [prose] });
    expect(out).toContain(
      [
        '- §1 prose "The identity service owns accounts.":',
        'The identity service owns accounts.',
      ].join('\n'),
    );
    expect(out).not.toContain('```\nThe identity service');
  });

  it('lists the changed blocks in the order given', () => {
    const out = build({ changed: [diagram, prose] });
    expect(out.indexOf('- §2 diagram:')).toBeLessThan(out.indexOf('- §1 prose'));
  });

  it('anchored comment quotes the block snippet and the text', () => {
    const out = build({ comments: [anchored(1)] });
    expect(out).toContain(
      `Open comments (1):\n- §2 ${diagram.snippet}: "This should not talk to identity directly."`,
    );
  });

  it('detached comment is labelled (detached)', () => {
    const out = build({
      comments: [anchored(null, { anchor: { index: 9, hash: 'x', snippet: 'gone block' } })],
    });
    expect(out).toContain('- (detached) gone block: "This should not talk to identity directly."');
    expect(out).not.toContain('- §');
  });

  it('a comment pointing past the end of the block list is detached, not a crash', () => {
    const out = build({
      comments: [anchored(42, { anchor: { index: 42, hash: 'x', snippet: 'stale' } })],
    });
    expect(out).toContain('- (detached) stale: "This should not talk to identity directly."');
  });

  it('collapses newlines in the comment text onto one line', () => {
    const out = build({ comments: [anchored(1, { text: 'first line\n\nsecond line' })] });
    expect(out).toContain(`- §2 ${diagram.snippet}: "first line second line"`);
  });

  it('sent and resolved comments are excluded', () => {
    const out = build({
      comments: [
        anchored(1, { id: 'sent', text: 'already sent', sentAt: '2026-09-19T11:00:00.000Z' }),
        anchored(1, { id: 'done', text: 'already resolved', status: 'resolved' }),
        anchored(1, { id: 'live', text: 'still open' }),
      ],
    });
    expect(out).toContain('Open comments (1):');
    expect(out).toContain('"still open"');
    expect(out).not.toContain('already sent');
    expect(out).not.toContain('already resolved');
  });

  it('removed count line appears only when > 0', () => {
    expect(build({ removed: 0 })).not.toContain('Removed blocks:');
    const out = build({ changed: [prose], removed: 3 });
    expect(out).toContain('Removed blocks: 3');
    expect(out.indexOf('- §1 prose')).toBeLessThan(out.indexOf('Removed blocks: 3'));
    expect(out.indexOf('Removed blocks: 3')).toBeLessThan(out.indexOf('Open comments'));
  });
});
