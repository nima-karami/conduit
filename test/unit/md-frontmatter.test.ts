import { describe, expect, it } from 'vitest';
import { parseFrontmatter, remarkFrontmatterCard } from '../../webview/md-frontmatter';

describe('parseFrontmatter', () => {
  it('parses flat key: value scalars', () => {
    expect(parseFrontmatter('status: active\ndate: 2026-06-18')).toEqual([
      ['status', 'active'],
      ['date', '2026-06-18'],
    ]);
  });

  it('unquotes quoted values', () => {
    expect(parseFrontmatter('title: "Hello World"\nname: \'Conduit\'')).toEqual([
      ['title', 'Hello World'],
      ['name', 'Conduit'],
    ]);
  });

  it('flattens an inline flow list', () => {
    expect(parseFrontmatter('tags: [a, b, c]')).toEqual([['tags', 'a, b, c']]);
  });

  it('collects a block list under a key', () => {
    expect(parseFrontmatter('tags:\n  - one\n  - two\nstatus: ok')).toEqual([
      ['tags', 'one, two'],
      ['status', 'ok'],
    ]);
  });

  it('tolerates CRLF and skips malformed lines without throwing', () => {
    expect(parseFrontmatter('a: 1\r\n???not yaml???\r\nb: 2')).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('returns [] for empty frontmatter', () => {
    expect(parseFrontmatter('')).toEqual([]);
    expect(parseFrontmatter('   \n  ')).toEqual([]);
  });
});

describe('remarkFrontmatterCard', () => {
  const run = remarkFrontmatterCard();
  // biome-ignore lint/suspicious/noExplicitAny: loose mdast fixtures
  const tree = (...children: any[]): any => ({ type: 'root', children });

  it('replaces a leading yaml node with a frontmatter card', () => {
    const t = tree({ type: 'yaml', value: 'status: active\ndate: 2026-06-18' });
    run(t);
    const card = t.children[0];
    expect(card.type).toBe('blockquote');
    expect(card.data.hName).toBe('div');
    expect(card.data.hProperties.className).toEqual(['markdown-frontmatter']);
    expect(card.children).toHaveLength(2); // two rows
    expect(card.children[0].data.hProperties.className).toEqual(['markdown-frontmatter__row']);
    // key + value spans
    expect(card.children[0].children[0].children[0].value).toBe('status');
    expect(card.children[0].children[1].children[0].value).toBe('active');
  });

  it('drops empty frontmatter entirely (no stray node)', () => {
    const t = tree({ type: 'yaml', value: '   ' }, { type: 'paragraph', children: [] });
    run(t);
    expect(t.children).toHaveLength(1);
    expect(t.children[0].type).toBe('paragraph');
  });

  it('is a no-op when there is no yaml node', () => {
    const t = tree({ type: 'heading', depth: 1, children: [{ type: 'text', value: 'Hi' }] });
    const before = JSON.stringify(t);
    run(t);
    expect(JSON.stringify(t)).toBe(before);
  });
});
