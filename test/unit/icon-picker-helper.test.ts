import { describe, expect, it } from 'vitest';
import {
  buildIconEntries,
  filterAndGroupIcons,
  toKebabCase,
  toPascalCase,
} from '../../webview/icon-picker-helper';

describe('toKebabCase', () => {
  it('converts PascalCase to kebab-case', () => {
    expect(toKebabCase('ArrowDown')).toBe('arrow-down');
    expect(toKebabCase('FileText')).toBe('file-text');
    expect(toKebabCase('Github')).toBe('github');
  });

  it('handles consecutive capitals (e.g. Lucide ALargeSmall → a-large-small)', () => {
    expect(toKebabCase('ALargeSmall')).toBe('a-large-small');
    expect(toKebabCase('AArrowDown')).toBe('a-arrow-down');
  });
});

describe('toPascalCase', () => {
  it('converts kebab-case to PascalCase', () => {
    expect(toPascalCase('arrow-down')).toBe('ArrowDown');
    expect(toPascalCase('file-text')).toBe('FileText');
    expect(toPascalCase('github')).toBe('Github');
    expect(toPascalCase('a-large-small')).toBe('ALargeSmall');
  });
});

describe('buildIconEntries', () => {
  // Minimal synthetic set of PascalCase names that mimic lucide-react exports.
  const mockKeys = [
    'ArrowDown',
    'ArrowDownIcon', // alias — should be excluded
    'ArrowUp',
    'ArrowUpIcon', // alias — should be excluded
    'FileText',
    'FileTextIcon',
    'Github',
    'GithubIcon',
    'createLucideIcon', // utility — should be excluded
    'LucideProvider', // utility — should be excluded
  ];

  it('excludes Icon-suffixed aliases and utility exports', () => {
    const entries = buildIconEntries(mockKeys);
    const names = entries.map((e) => e.pascal);
    expect(names).not.toContain('ArrowDownIcon');
    expect(names).not.toContain('ArrowUpIcon');
    expect(names).not.toContain('FileTextIcon');
    expect(names).not.toContain('GithubIcon');
    expect(names).not.toContain('createLucideIcon');
    expect(names).not.toContain('LucideProvider');
  });

  it('includes real icon names in kebab-case and PascalCase', () => {
    const entries = buildIconEntries(mockKeys);
    const arrowDown = entries.find((e) => e.pascal === 'ArrowDown');
    expect(arrowDown).toBeDefined();
    expect(arrowDown?.kebab).toBe('arrow-down');
  });

  it('assigns a category to each icon', () => {
    const entries = buildIconEntries(mockKeys);
    for (const e of entries) {
      expect(typeof e.category).toBe('string');
      expect(e.category.length).toBeGreaterThan(0);
    }
  });

  it('sorts entries by kebab name', () => {
    const entries = buildIconEntries(mockKeys);
    const kebabs = entries.map((e) => e.kebab);
    expect(kebabs).toEqual([...kebabs].sort());
  });
});

describe('filterAndGroupIcons', () => {
  const mockKeys = [
    'ArrowDown',
    'ArrowDownIcon',
    'ArrowUp',
    'ArrowUpIcon',
    'FileText',
    'FileTextIcon',
    'Github',
    'GithubIcon',
    'Rocket',
    'RocketIcon',
    'Star',
    'StarIcon',
  ];
  const entries = buildIconEntries(mockKeys);

  it('returns a single flat group when searching', () => {
    const groups = filterAndGroupIcons(entries, 'arrow');
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe('');
    const names = groups[0].entries.map((e) => e.kebab);
    expect(names.every((n) => n.includes('arrow'))).toBe(true);
    // Non-matching icons excluded.
    expect(names).not.toContain('file-text');
  });

  it('returns an empty array when nothing matches the query', () => {
    const groups = filterAndGroupIcons(entries, 'xyzzznotaniconsearch');
    expect(groups).toHaveLength(0);
  });

  it('returns category groups when query is empty', () => {
    const groups = filterAndGroupIcons(entries, '');
    // All groups should have a non-empty category name.
    for (const g of groups) {
      expect(typeof g.category).toBe('string');
      // Every entry should be in the group.
      expect(g.entries.length).toBeGreaterThan(0);
    }
    // Total icons across groups should equal entries count.
    const total = groups.reduce((sum, g) => sum + g.entries.length, 0);
    expect(total).toBe(entries.length);
  });

  it('case-insensitive search', () => {
    const lower = filterAndGroupIcons(entries, 'arrow');
    const upper = filterAndGroupIcons(entries, 'ARROW');
    expect(lower.length).toBe(upper.length);
    if (lower.length > 0 && upper.length > 0) {
      expect(lower[0].entries.map((e) => e.kebab)).toEqual(upper[0].entries.map((e) => e.kebab));
    }
  });

  it('search trims whitespace', () => {
    const groups = filterAndGroupIcons(entries, '  ');
    // Same as empty: returns category groups.
    for (const g of groups) {
      expect(typeof g.category).toBe('string');
    }
  });
});
