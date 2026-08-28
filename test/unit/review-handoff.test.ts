import { describe, expect, it } from 'vitest';
import { buildHandoffMarkdown, handoffLabel } from '../../src/review-handoff';
import { anchorFor, type ReviewNote } from '../../src/review-notes';

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

describe('buildHandoffMarkdown', () => {
  it('matches the spec format exactly, with no trailing newline', () => {
    const md = buildHandoffMarkdown(
      [
        note({ id: 'a' }),
        note({ id: 'b', path: 'src/bar.ts', line: 7, snippet: 'return y;', body: 'unused?' }),
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

  it('singularises one file', () => {
    expect(buildHandoffMarkdown([note({})], ['src/foo.ts'], 'staged changes')).toContain(
      'Review notes on 1 file (staged changes):',
    );
  });

  it('orders files by the review order and lines ascending inside a file', () => {
    const md = buildHandoffMarkdown(
      [
        note({ id: 'c', line: 9 }),
        note({ id: 'a', line: 2 }),
        note({ id: 'b', path: 'a.ts', line: 1 }),
      ],
      ['a.ts', 'src/foo.ts'],
      'working tree',
    );
    expect(md.indexOf('### a.ts')).toBeLessThan(md.indexOf('### src/foo.ts'));
    expect(md.indexOf('- L2')).toBeLessThan(md.indexOf('- L9'));
  });

  it('appends a file the review order does not mention, rather than dropping its notes', () => {
    const md = buildHandoffMarkdown([note({ path: 'gone.ts' })], ['src/foo.ts'], 'working tree');
    expect(md).toContain('### gone.ts');
  });

  it('indents the continuation lines of a multi-line body so the list survives', () => {
    const md = buildHandoffMarkdown(
      [note({ body: 'first\nsecond' })],
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

  it('falls back to the clipboard when there is no live terminal', () => {
    const r = handoffLabel(2, false);
    expect(r.label).toBe('Copy as markdown');
    expect(r.disabled).toBe(false);
    expect(r.title).toContain('no live terminal');
  });

  it('is disabled at zero, both ways', () => {
    expect(handoffLabel(0, true).disabled).toBe(true);
    expect(handoffLabel(0, false).disabled).toBe(true);
  });
});
