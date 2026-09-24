import { describe, expect, it } from 'vitest';
import {
  buildGroupedHandoffMarkdown,
  buildHandoffMarkdown,
  type HandoffRepo,
  handoffLabel,
  handoffPathPrefix,
} from '../../src/review-handoff';
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

describe('buildGroupedHandoffMarkdown', () => {
  const repo = (over: Partial<HandoffRepo>): HandoffRepo => ({
    name: 'rmb',
    pathPrefix: '',
    notes: [],
    files: [],
    ...over,
  });

  it('two repos → first line "Review notes on 3 files in 2 repos (working tree):", "## rmb" then "## proto"', () => {
    const md = buildGroupedHandoffMarkdown(
      [
        repo({
          name: 'rmb',
          notes: [at({ id: 'a' }), at({ id: 'b', path: 'src/bar.ts', line: 7 })],
          files: ['src/foo.ts', 'src/bar.ts'],
        }),
        repo({
          name: 'proto',
          pathPrefix: 'vendor/proto-schemas/',
          notes: [at({ id: 'c', path: 'room.proto', line: 3, snippet: 'message Room {' })],
          files: ['room.proto'],
        }),
      ],
      'working tree',
    );
    expect(md).toBe(
      [
        'Review notes on 3 files in 2 repos (working tree):',
        '',
        '## rmb',
        '',
        '### src/foo.ts',
        '- L42 (`const x = 1;`): why this?',
        '',
        '### src/bar.ts',
        '- L7 (`const x = 1;`): why this?',
        '',
        '## proto',
        '',
        '### vendor/proto-schemas/room.proto',
        '- L3 (`message Room {`): why this?',
        '',
        'Please address these and reply with what you changed.',
      ].join('\n'),
    );
  });

  it('nested prefix → "### vendor/proto-schemas/room.proto"', () => {
    const md = buildGroupedHandoffMarkdown(
      [
        repo({
          name: 'proto',
          pathPrefix: handoffPathPrefix('G:/rmb/vendor/proto-schemas', 'G:/rmb'),
          notes: [at({ path: 'room.proto' })],
          files: ['room.proto'],
        }),
      ],
      'working tree',
    );
    expect(md.split('\n')).toContain('### vendor/proto-schemas/room.proto');
  });

  it('attached → absolute "### /x/ci/README.md"', () => {
    const md = buildGroupedHandoffMarkdown(
      [
        repo({
          name: 'ci',
          pathPrefix: handoffPathPrefix('/x/ci', '/home/me/rmb'),
          notes: [at({ path: 'README.md' })],
          files: ['README.md'],
        }),
      ],
      'working tree',
    );
    expect(md.split('\n')).toContain('### /x/ci/README.md');
  });

  it('a repo with notes but no listed files still gets its section', () => {
    const md = buildGroupedHandoffMarkdown(
      [
        repo({ name: 'rmb', notes: [at({ id: 'a' })], files: ['src/foo.ts'] }),
        repo({ name: 'proto', pathPrefix: 'proto/', notes: [at({ id: 'c', path: 'room.proto' })] }),
      ],
      'working tree',
    );
    const lines = md.split('\n');
    expect(lines[0]).toBe('Review notes on 2 files in 2 repos (working tree):');
    expect(lines.slice(lines.indexOf('## proto'))).toEqual([
      '## proto',
      '',
      '### proto/room.proto',
      '- L42 (`const x = 1;`): why this?',
      '',
      'Please address these and reply with what you changed.',
    ]);
  });

  it('repos without notes omitted and not counted', () => {
    const md = buildGroupedHandoffMarkdown(
      [
        repo({ name: 'rmb', notes: [at({})], files: ['src/foo.ts'] }),
        repo({ name: 'quiet', files: ['a.ts', 'b.ts'] }),
      ],
      'staged changes',
    );
    expect(md.split('\n')[0]).toBe('Review notes on 1 file in 1 repos (staged changes):');
    expect(md).not.toContain('## quiet');
    expect(buildGroupedHandoffMarkdown([repo({ files: ['a.ts'] })], 'working tree')).toBe('');
  });

  it("closing line identical to buildHandoffMarkdown's", () => {
    const notes = [at({})];
    const single = buildHandoffMarkdown(notes, ['src/foo.ts'], 'working tree').split('\n');
    const grouped = buildGroupedHandoffMarkdown(
      [repo({ notes, files: ['src/foo.ts'] })],
      'working tree',
    ).split('\n');
    expect(grouped.at(-1)).toBe(single.at(-1));
    expect(grouped.at(-2)).toBe('');
  });

  it('handoffPathPrefix: root === home → ""; C:\\h\\sub vs C:/h → "sub/"', () => {
    expect(handoffPathPrefix('C:/h', 'C:/h')).toBe('');
    expect(handoffPathPrefix('c:\\h\\', 'C:/h')).toBe('');
    expect(handoffPathPrefix('C:\\h\\sub', 'C:/h')).toBe('sub/');
    expect(handoffPathPrefix('C:\\h\\Sub\\Deep', 'c:/h/')).toBe('Sub/Deep/');
    expect(handoffPathPrefix('C:/hx', 'C:/h')).toBe('C:/hx/');
    expect(handoffPathPrefix('D:\\x\\ci', 'C:/h')).toBe('D:/x/ci/');
  });
});
