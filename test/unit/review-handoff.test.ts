import { describe, expect, it } from 'vitest';
import { buildHandoffMarkdown, handoffLabel } from '../../src/review-handoff';
import { type AnchoredNote, anchorFor, type ReviewNote } from '../../src/review-notes';

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: 'n',
  path: 'src/foo.ts',
  side: 'new',
  line: 42,
  anchor: anchorFor('const x = 1;', null, null),
  snippet: 'const x = 1;',
  body: 'why this?',
  createdAt: '2026-08-28T10:00:00.000Z',
  ...over,
});

/** A note sitting where `reanchor` currently finds it; `line` defaults to the stored one. */
const at = (over: Partial<ReviewNote>, line?: number | null): AnchoredNote => {
  const n = note(over);
  return { note: n, line: line === undefined ? n.line : line };
};

describe('buildHandoffMarkdown', () => {
  it('matches the spec format exactly, with no trailing newline', () => {
    const md = buildHandoffMarkdown(
      [
        at({ id: 'a' }),
        at({ id: 'b', path: 'src/bar.ts', line: 7, snippet: 'return y;', body: 'unused?' }),
      ],
      ['src/foo.ts', 'src/bar.ts'],
      'working tree',
    );
    expect(md).toBe(
      [
        'Review notes on 2 files (working tree):',
        '',
        '### src/foo.ts',
        '- L42 (`const x = 1;`): why this?',
        '',
        '### src/bar.ts',
        '- L7 (`return y;`): unused?',
        '',
        'Please address these and reply with what you changed.',
      ].join('\n'),
    );
    expect(md.endsWith('\n')).toBe(false);
  });

  it('sends the RE-ANCHORED line, not the one the note was stored with', () => {
    // The whole point: `reanchor` never rewrites `note.line`, so a note written before an edit
    // above it still carries line 42 in the store while it now sits on 47.
    const md = buildHandoffMarkdown([at({}, 47)], ['src/foo.ts'], 'working tree');
    expect(md).toContain('- L47 (`const x = 1;`): why this?');
    expect(md).not.toContain('L42');
  });

  it('says so for a note whose line is gone, rather than quoting a stale number', () => {
    const md = buildHandoffMarkdown([at({}, null)], ['src/foo.ts'], 'working tree');
    expect(md).toContain('- (was line 42: `const x = 1;` — that line is gone): why this?');
  });

  it('lists detached notes after the located ones', () => {
    const md = buildHandoffMarkdown(
      [at({ id: 'gone' }, null), at({ id: 'here', line: 9 }, 9)],
      ['src/foo.ts'],
      'working tree',
    );
    expect(md.indexOf('- L9')).toBeLessThan(md.indexOf('was line 42'));
  });

  it('singularises one file', () => {
    expect(buildHandoffMarkdown([at({})], ['src/foo.ts'], 'staged changes')).toContain(
      'Review notes on 1 file (staged changes):',
    );
  });

  it('orders files by the review order and lines ascending inside a file', () => {
    const md = buildHandoffMarkdown(
      [at({ id: 'c', line: 9 }), at({ id: 'a', line: 2 }), at({ id: 'b', path: 'a.ts', line: 1 })],
      ['a.ts', 'src/foo.ts'],
      'working tree',
    );
    expect(md.indexOf('### a.ts')).toBeLessThan(md.indexOf('### src/foo.ts'));
    expect(md.indexOf('- L2')).toBeLessThan(md.indexOf('- L9'));
  });

  it('appends a file the review order does not mention, rather than dropping its notes', () => {
    const md = buildHandoffMarkdown([at({ path: 'gone.ts' })], ['src/foo.ts'], 'working tree');
    expect(md).toContain('### gone.ts');
  });

  it('indents the continuation lines of a multi-line body so the list survives', () => {
    const md = buildHandoffMarkdown(
      [at({ body: 'first\nsecond' })],
      ['src/foo.ts'],
      'working tree',
    );
    expect(md).toContain('- L42 (`const x = 1;`): first\n  second');
  });

  it('is empty for no notes, so a caller can gate on it', () => {
    expect(buildHandoffMarkdown([], ['src/foo.ts'], 'working tree')).toBe('');
  });
});

describe('handoffLabel', () => {
  it('offers the send when a terminal is live and something is pending', () => {
    expect(handoffLabel(4, true)).toEqual({
      label: 'Send to agent (4)',
      title: 'Paste 4 open notes into this session (you press Enter)',
      disabled: false,
    });
  });

  it('falls back to the clipboard when nothing can take a multi-line paste', () => {
    const r = handoffLabel(2, false);
    expect(r.label).toBe('Copy as markdown');
    expect(r.disabled).toBe(false);
    expect(r.title).toContain('no terminal ready to take a multi-line paste');
  });

  it('is disabled at zero, both ways', () => {
    expect(handoffLabel(0, true).disabled).toBe(true);
    expect(handoffLabel(0, false).disabled).toBe(true);
  });
});
