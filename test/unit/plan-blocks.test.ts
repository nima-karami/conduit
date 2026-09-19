import { describe, expect, it } from 'vitest';
import { composePlan, normalizeBlockSource, SNIPPET_CHARS, splitPlan } from '../../src/plan-blocks';

const DOC = [
  '# Heading',
  '',
  'Some prose that runs on for quite a while so the snippet has to be cut somewhere sensible.',
  '',
  '```ts',
  'const a = 1;',
  '```',
  '',
  '```mermaid',
  'flowchart TD',
  '  a --> b',
  '```',
  '',
  '- one',
  '- two',
  '',
].join('\n');

const FRONTMATTER = '---\ntitle: x\n---\n\n';

describe('splitPlan', () => {
  it('frontmatter is split off verbatim and is not a block', () => {
    const split = splitPlan('---\ntitle: x\n---\n\n# H\n');
    expect(split.frontmatter).toBe('---\ntitle: x\n---\n\n');
    expect(split.body).toBe('# H\n');
    expect(split.blocks.map((b) => b.kind)).toEqual(['prose']);
    expect(split.blocks.map((b) => b.index)).toEqual([0]);
  });

  it('fences classify by lang', () => {
    const split = splitPlan(DOC);
    expect(split.frontmatter).toBe('');
    expect(split.blocks.map((b) => [b.kind, b.lang])).toEqual([
      ['prose', null],
      ['prose', null],
      ['code', 'ts'],
      ['diagram', 'mermaid'],
      ['prose', null],
    ]);
  });

  it('offsets slice back to source', () => {
    const split = splitPlan(FRONTMATTER + DOC);
    expect(split.blocks).toHaveLength(5);
    expect(split.blocks.map((b) => b.index)).toEqual([0, 1, 2, 3, 4]);
    expect(split.blocks.map((b) => split.body.slice(b.start, b.end))).toEqual(
      split.blocks.map((b) => b.source),
    );
    expect(split.body.slice(split.blocks[2]?.start, split.blocks[2]?.end)).toBe(
      '```ts\nconst a = 1;\n```',
    );
  });

  it('hash ignores CRLF and outer whitespace', () => {
    expect(normalizeBlockSource('  a\r\nb  \n')).toBe('a\nb');
    const lf = splitPlan(DOC);
    const crlf = splitPlan(DOC.replace(/\n/g, '\r\n'));
    expect(crlf.blocks).toHaveLength(lf.blocks.length);
    expect(crlf.blocks.map((b) => b.hash)).toEqual(lf.blocks.map((b) => b.hash));
    expect(lf.blocks.map((b) => b.hash)).not.toContain('');
  });

  it('snippet is the first non-empty line capped at 60', () => {
    const split = splitPlan(DOC);
    expect(split.blocks).toHaveLength(5);
    expect(split.blocks[0]?.snippet).toBe('# Heading');
    expect(split.blocks[1]?.snippet).toBe(
      'Some prose that runs on for quite a while so the snippet has',
    );
    expect(split.blocks[1]?.snippet).toHaveLength(SNIPPET_CHARS);
    expect(split.blocks[3]?.snippet).toBe('```mermaid');
  });
});

describe('composePlan', () => {
  it('composePlan ends with exactly one newline', () => {
    expect(composePlan(FRONTMATTER, '# H\n\n\n')).toBe(`${FRONTMATTER}# H\n`);
    expect(composePlan('', '# H')).toBe('# H\n');
    expect(composePlan('', '# H\n')).toBe('# H\n');
  });
});
