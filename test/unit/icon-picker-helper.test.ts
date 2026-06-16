import { describe, expect, it } from 'vitest';
import {
  buildIconEntries,
  countFilteredIcons,
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
    'Trash2',
    'Trash2Icon',
  ];
  const mockTagsMap: Record<string, string[]> = {
    'arrow-down': ['backwards', 'reverse', 'direction', 'south'],
    'trash-2': ['garbage', 'delete', 'remove', 'bin'],
    rocket: ['launch', 'startup', 'spaceship', 'fast'],
    star: ['favorite', 'bookmark', 'rating', 'review'],
  };
  const entries = buildIconEntries(mockKeys, mockTagsMap);

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

  // ── tag-based search tests ────────────────────────────────────────────────

  it('tag match: "delete" surfaces trash2 via its tags (synonym search)', () => {
    // "delete" does not appear in the icon name "trash2", but is in its tags.
    // The tagsMap uses lucide-static's canonical "trash-2" key; buildIconEntries
    // normalizes digit-adjacent hyphens so it matches the entry's kebab "trash2".
    const groups = filterAndGroupIcons(entries, 'delete');
    expect(groups).toHaveLength(1);
    const names = groups[0].entries.map((e) => e.kebab);
    expect(names).toContain('trash2');
  });

  it('tag match: "garbage" also surfaces trash2', () => {
    const groups = filterAndGroupIcons(entries, 'garbage');
    expect(groups).toHaveLength(1);
    const names = groups[0].entries.map((e) => e.kebab);
    expect(names).toContain('trash2');
  });

  it('tag match is case-insensitive', () => {
    const lower = filterAndGroupIcons(entries, 'delete');
    const upper = filterAndGroupIcons(entries, 'DELETE');
    expect(lower.length).toBeGreaterThan(0);
    expect(lower[0].entries.map((e) => e.kebab)).toEqual(upper[0].entries.map((e) => e.kebab));
  });

  it('name match still works alongside tag match', () => {
    // "arrow" matches arrow-down and arrow-up by name; neither has "arrow" in tags.
    const groups = filterAndGroupIcons(entries, 'arrow');
    expect(groups).toHaveLength(1);
    const names = groups[0].entries.map((e) => e.kebab);
    expect(names).toContain('arrow-down');
    expect(names).toContain('arrow-up');
    expect(names).not.toContain('trash2');
  });

  it('icons with no tags still appear in name-based results', () => {
    // github has no entry in mockTagsMap, so tags = [].
    // A name-based search for "github" should still find it.
    const groups = filterAndGroupIcons(entries, 'github');
    expect(groups).toHaveLength(1);
    const names = groups[0].entries.map((e) => e.kebab);
    expect(names).toContain('github');
  });

  it('buildIconEntries populates tags from the provided map (normalizing digit hyphens)', () => {
    // The tagsMap uses "trash-2" (lucide-static canonical), entry kebab is "trash2".
    const trash = entries.find((e) => e.kebab === 'trash2');
    expect(trash).toBeDefined();
    expect(trash?.tags).toContain('delete');
    expect(trash?.tags).toContain('bin');
  });

  it('buildIconEntries uses empty tags for icons not in the map', () => {
    const github = entries.find((e) => e.kebab === 'github');
    expect(github).toBeDefined();
    expect(github?.tags).toEqual([]);
  });
});

// ── Defect 1: no duplicate kebab names across all category groups ─────────────
describe('buildIconEntries — no duplicate kebab names', () => {
  it('produces no duplicate kebab names when both AZ and Az variants are in the input', () => {
    // Simulate lucide-react exporting both ArrowDownAZ and ArrowDownAz (same kebab)
    const mockKeys = [
      'ArrowDownAZ',
      'ArrowDownAZIcon',
      'ArrowDownAz',
      'ArrowDownAzIcon',
      'ArrowUpAZ',
      'ArrowUpAZIcon',
      'ArrowUpAz',
      'ArrowUpAzIcon',
      'ArrowDownZA',
      'ArrowDownZAIcon',
      'ArrowDownZa',
      'ArrowDownZaIcon',
      'ArrowUpZA',
      'ArrowUpZAIcon',
      'ArrowUpZa',
      'ArrowUpZaIcon',
      'FileText',
      'FileTextIcon',
    ];
    const entries = buildIconEntries(mockKeys);
    const kebabs = entries.map((e) => e.kebab);
    const unique = new Set(kebabs);
    expect(kebabs.length).toBe(unique.size);
    // Specifically these four should each appear exactly once
    for (const name of ['arrow-down-az', 'arrow-up-az', 'arrow-down-za', 'arrow-up-za']) {
      expect(kebabs.filter((k) => k === name)).toHaveLength(1);
    }
  });

  it('each icon name appears in at most one category group', () => {
    const mockKeys = [
      'ArrowDownAZ',
      'ArrowDownAZIcon',
      'ArrowDownAz',
      'ArrowDownAzIcon',
      'ArrowUp',
      'ArrowUpIcon',
      'FileText',
      'FileTextIcon',
      'Github',
      'GithubIcon',
    ];
    const entries = buildIconEntries(mockKeys);
    const groups = filterAndGroupIcons(entries, '');
    const seenKebabs = new Set<string>();
    for (const group of groups) {
      for (const entry of group.entries) {
        expect(seenKebabs.has(entry.kebab)).toBe(false);
        seenKebabs.add(entry.kebab);
      }
    }
  });
});

// ── Defect 3: countFilteredIcons returns accurate live counts ─────────────────
describe('countFilteredIcons', () => {
  const mockKeys = [
    'ArrowDown',
    'ArrowDownIcon',
    'ArrowUp',
    'ArrowUpIcon',
    'FileText',
    'FileTextIcon',
    'Github',
    'GithubIcon',
    'Trash2',
    'Trash2Icon',
  ];
  const mockTagsMap: Record<string, string[]> = {
    'trash-2': ['garbage', 'delete', 'remove', 'bin'],
  };
  const entries = buildIconEntries(mockKeys, mockTagsMap);

  it('returns total count when query is empty', () => {
    expect(countFilteredIcons(entries, '')).toBe(entries.length);
  });

  it('returns total count when query is only whitespace', () => {
    expect(countFilteredIcons(entries, '  ')).toBe(entries.length);
  });

  it('returns filtered count matching by name', () => {
    // "arrow" matches arrow-down and arrow-up
    const count = countFilteredIcons(entries, 'arrow');
    expect(count).toBe(2);
  });

  it('returns filtered count matching by tag', () => {
    // "delete" matches trash2 via tags
    const count = countFilteredIcons(entries, 'delete');
    expect(count).toBe(1);
  });

  it('returns 0 when nothing matches', () => {
    expect(countFilteredIcons(entries, 'xyzzznotaniconsearch')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(countFilteredIcons(entries, 'ARROW')).toBe(countFilteredIcons(entries, 'arrow'));
  });
});
