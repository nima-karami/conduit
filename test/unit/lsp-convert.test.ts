import { describe, expect, it } from 'vitest';
import { offsetAt, symbolKindName, toHover, toLocations, toNavTree } from '../../src/lsp-convert';

const R = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

describe('toLocations', () => {
  it('LocationLink uses targetSelectionRange', () => {
    expect(
      toLocations([
        {
          targetUri: 'file:///w/a.go',
          targetRange: R(0, 0, 9, 1),
          targetSelectionRange: R(2, 5, 2, 11),
        },
      ]),
    ).toEqual([{ path: '/w/a.go', range: R(2, 5, 2, 11) }]);
  });

  it('upper-case drive URIs map to canonical paths', () => {
    expect(toLocations({ uri: 'file:///c%3A/w/a%20b.go', range: R(1, 0, 1, 3) })).toEqual([
      { path: 'C:\\w\\a b.go', range: R(1, 0, 1, 3) },
    ]);
  });

  it('non-file dropped', () => {
    expect(toLocations([{ uri: 'jar:x', range: R(0, 0, 0, 0) }])).toEqual([]);
    expect(toLocations(null)).toEqual([]);
  });

  it('duplicates collapse', () => {
    const loc = { uri: 'file:///C:/w/a.go', range: R(1, 0, 1, 3) };
    expect(toLocations([loc, { ...loc, uri: 'file:///c:/w/a.go' }, loc])).toHaveLength(1);
  });
});

describe('toHover', () => {
  it('MarkupContent passes through', () => {
    expect(
      toHover({ contents: { kind: 'markdown', value: '**x**' }, range: R(0, 1, 0, 2) }),
    ).toEqual({
      markdown: '**x**',
      range: R(0, 1, 0, 2),
    });
  });

  it('MarkedString array joined with fences', () => {
    expect(toHover({ contents: [{ language: 'go', value: 'func F()' }, 'Doc.'] })).toEqual({
      markdown: '```go\nfunc F()\n```\n\nDoc.',
    });
  });

  it('empty hover is null', () => {
    expect(toHover({ contents: '' })).toBeNull();
    expect(toHover(null)).toBeNull();
  });
});

describe('toNavTree', () => {
  const text = 'package m\n\ntype T struct {\n\tA int\n}\n\nfunc F() {}\n';

  it('hierarchical symbols keep nesting and offsets', () => {
    const tree = toNavTree(
      [
        {
          name: 'T',
          kind: 23,
          range: R(2, 0, 4, 1),
          selectionRange: R(2, 5, 2, 6),
          children: [{ name: 'A', kind: 8, range: R(3, 1, 3, 6), selectionRange: R(3, 1, 3, 2) }],
        },
        { name: 'F', kind: 12, range: R(6, 0, 6, 11), selectionRange: R(6, 5, 6, 6) },
      ],
      text,
      'm.go',
    );
    expect(tree.text).toBe('m.go');
    expect(tree.spans).toEqual([{ start: 0, length: text.length }]);
    const [t, f] = tree.childItems ?? [];
    expect(t).toMatchObject({ text: 'T', kind: 'class', spans: [{ start: 11, length: 24 }] });
    expect(t?.childItems?.[0]).toMatchObject({
      text: 'A',
      kind: 'property',
      spans: [{ start: 28, length: 5 }],
    });
    expect(f).toMatchObject({ text: 'F', kind: 'function', spans: [{ start: 37, length: 11 }] });
    expect(text.slice(37, 48)).toBe('func F() {}');
  });

  it('flat SymbolInformation becomes one level', () => {
    const tree = toNavTree(
      [{ name: 'F', kind: 12, location: { uri: 'file:///m.go', range: R(6, 0, 6, 11) } }],
      text,
      'm.go',
    );
    expect(tree.childItems).toEqual([
      { text: 'F', kind: 'function', spans: [{ start: 37, length: 11 }] },
    ]);
  });

  it('unknown kind → empty string', () => {
    expect(symbolKindName(2)).toBe('');
    expect(symbolKindName(999)).toBe('');
    expect(symbolKindName(14)).toBe('const');
    expect(symbolKindName(6)).toBe('method');
  });
});

describe('offsetAt', () => {
  it('offsetAt clamps', () => {
    expect(offsetAt('ab\ncd', { line: 0, character: 99 })).toBe(2);
    expect(offsetAt('ab\ncd', { line: 9, character: 1 })).toBe(4);
    expect(offsetAt('ab\ncd', { line: 1, character: 99 })).toBe(5);
    expect(offsetAt('', { line: 0, character: 3 })).toBe(0);
  });

  it('CRLF offsets count the \\r', () => {
    expect(offsetAt('a\r\nb', { line: 1, character: 0 })).toBe(3);
    expect(offsetAt('a\r\nb', { line: 0, character: 5 })).toBe(2);
  });
});
