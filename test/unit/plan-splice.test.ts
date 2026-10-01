import { describe, expect, it } from 'vitest';
import { splitPlan } from '../../src/plan-blocks';
import { keepMap, type SpliceItem, spliceBody } from '../../src/plan-splice';

const DOC = [
  '# Title',
  '',
  '',
  'first paragraph with *em* inside.',
  '',
  'second paragraph.',
  '',
].join('\n');

const FOUR = [
  '# Title',
  '',
  '',
  'first paragraph with *em* inside.',
  '',
  'middle paragraph.',
  '',
  'last paragraph.',
  '',
].join('\n');

const keep = (oldIndex: number): SpliceItem => ({ kind: 'keep', oldIndex });
const fresh = (source: string): SpliceItem => ({ kind: 'new', source });

describe('spliceBody', () => {
  it('all-keep reproduces the body byte for byte', () => {
    const { body, blocks } = splitPlan(DOC);
    expect(blocks).toHaveLength(3);
    expect(body.slice(blocks[0].end, blocks[1].start)).toBe('\n\n\n');
    expect(body).toBe(DOC);

    expect(
      spliceBody(
        body,
        blocks,
        blocks.map((_, i) => keep(i)),
      ),
    ).toBe(body);
  });

  it('replacing the middle block keeps the outer bytes and old gaps', () => {
    const { body, blocks } = splitPlan(FOUR);
    expect(blocks).toHaveLength(4);

    const out = spliceBody(body, blocks, [
      keep(0),
      keep(1),
      fresh('replaced **bold** text.'),
      keep(3),
    ]);

    expect(out).toBe(
      '# Title\n\n\nfirst paragraph with *em* inside.\n\nreplaced **bold** text.\n\nlast paragraph.\n',
    );
    expect(out).toContain('*em*');
  });

  it('inserting between kept blocks joins with one blank line', () => {
    const { body, blocks } = splitPlan(DOC);

    const out = spliceBody(body, blocks, [keep(0), fresh('inserted.'), keep(1), keep(2)]);

    expect(out).toBe(
      '# Title\n\ninserted.\n\nfirst paragraph with *em* inside.\n\nsecond paragraph.\n',
    );
  });

  it('deleting a block drops its gap', () => {
    const { body, blocks } = splitPlan(DOC);

    expect(spliceBody(body, blocks, [keep(0), keep(2)])).toBe('# Title\n\nsecond paragraph.\n');
  });

  it('new source with trailing newlines is trimmed', () => {
    const { body, blocks } = splitPlan(DOC);

    expect(spliceBody(body, blocks, [fresh('a paragraph.\n\n\n'), keep(2)])).toBe(
      'a paragraph.\n\nsecond paragraph.\n',
    );
    expect(spliceBody(body, blocks, [fresh('only.\n\n')])).toBe('only.\n');
  });

  it('a block that replaces one keeps the old gaps on both sides', () => {
    const body = '# Title\n\n\nold paragraph.\n\n\n\nlast.\n';
    const { blocks } = splitPlan(body);

    expect(
      spliceBody(body, blocks, [
        keep(0),
        { kind: 'new', source: 'new paragraph.', replaces: 1 },
        keep(2),
      ]),
    ).toBe('# Title\n\n\nnew paragraph.\n\n\n\nlast.\n');
  });

  it('a fence that replaces a fence keeps its opener and closer, and refuses one it would break', () => {
    const body = 'Intro.\n\n~~~~mermaid title="x"\nflowchart LR\n  a --> b\n~~~~\n';
    const { blocks } = splitPlan(body);
    const swap = (source: string) =>
      spliceBody(body, blocks, [keep(0), { kind: 'new', source, replaces: 1 }]);

    expect(swap('```mermaid\nflowchart LR\n  a --> c\n```\n')).toBe(
      'Intro.\n\n~~~~mermaid title="x"\nflowchart LR\n  a --> c\n~~~~\n',
    );
    expect(swap('`````mermaid\nflowchart LR\n~~~~\n`````')).toBe(
      'Intro.\n\n`````mermaid\nflowchart LR\n~~~~\n`````\n',
    );
  });

  it('a fence whose language changed is written as the serialiser wrote it', () => {
    const body = 'Intro.\n\n~~~mermaid title="x"\nflowchart LR\n~~~\n';
    const { blocks } = splitPlan(body);

    expect(
      spliceBody(body, blocks, [
        keep(0),
        { kind: 'new', source: '```ts\nconst a = 1;\n```', replaces: 1 },
      ]),
    ).toBe('Intro.\n\n```ts\nconst a = 1;\n```\n');
  });

  it('a CRLF body takes CRLF for new blocks and their joins', () => {
    const body = '# Title\r\n\r\nfirst.\r\n';
    const { blocks } = splitPlan(body);

    expect(spliceBody(body, blocks, [keep(0), fresh('two\nlines.'), keep(1)])).toBe(
      '# Title\r\n\r\ntwo\r\nlines.\r\n\r\nfirst.\r\n',
    );
  });

  it('empty items yields empty string', () => {
    const { body, blocks } = splitPlan(DOC);

    expect(spliceBody(body, blocks, [])).toBe('');
  });
});

describe('keepMap', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };

  it('middle edit keeps 0 and 2', () => {
    expect(keepMap([a, b, c], [a, { id: 'b2' }, c])).toEqual([0, null, 2]);
  });

  it('insertion maps kept indices', () => {
    expect(keepMap([a, b], [a, { id: 'x' }, b])).toEqual([0, null, 1]);
  });

  it('deletion drops the index', () => {
    expect(keepMap([a, b, c], [a, c])).toEqual([0, 2]);
  });

  it('a swap matches only one of the two', () => {
    expect(keepMap([a, b], [b, a]).filter((x) => x !== null)).toHaveLength(1);
  });
});
