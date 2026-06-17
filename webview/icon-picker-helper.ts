/**
 * Pure helpers for the icon-picker modal (D3). Logic-only (no DOM/JSX/React) so they
 * unit-test in node without jsdom.
 *
 * Tags/synonyms come from `lucide-static`'s `tags.json` (kebab name → keywords), enabling
 * searches like "delete" to surface `trash-2`. lucide-static ships no category metadata,
 * so categories are derived from naming prefixes (see CATEGORY_RULES); unmatched icons
 * land in "Other".
 */

export interface IconEntry {
  kebab: string;
  pascal: string;
  category: string;
  tags: readonly string[];
}

/** Convert PascalCase → kebab-case. Handles consecutive capitals (e.g. ALargeSmall → a-large-small). */
export function toKebabCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

export function toPascalCase(s: string): string {
  return s
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Category ordering and prefix rules. Prefixes match as exact name (`chevron`) or exact
 * prefix (`chevron-`); the FIRST matching category wins and "Other" is the catch-all.
 * Best-effort from naming conventions since lucide-react ships no category metadata.
 */
const CATEGORY_RULES: { name: string; prefixes: string[] }[] = [
  {
    name: 'Arrows & Navigation',
    prefixes: ['arrow', 'chevron', 'corner', 'move', 'navigation', 'navigate', 'route', 'waypoint'],
  },
  {
    name: 'Files & Documents',
    prefixes: ['file', 'folder', 'archive', 'document'],
  },
  {
    name: 'Communication',
    prefixes: [
      'message',
      'mail',
      'chat',
      'send',
      'inbox',
      'bell',
      'speech',
      'at-sign',
      'megaphone',
      'phone',
      'contact',
    ],
  },
  {
    name: 'Media',
    prefixes: [
      'play',
      'pause',
      'stop',
      'volume',
      'music',
      'mic',
      'headphone',
      'audio',
      'radio',
      'video',
      'film',
      'camera',
      'image',
      'picture',
    ],
  },
  {
    name: 'Devices',
    prefixes: [
      'monitor',
      'laptop',
      'tablet',
      'smartphone',
      'keyboard',
      'printer',
      'server',
      'hard',
      'usb',
      'bluetooth',
      'wifi',
      'battery',
      'power',
      'plug',
      'cable',
    ],
  },
  {
    name: 'Charts & Data',
    prefixes: [
      'chart',
      'bar-chart',
      'line-chart',
      'pie',
      'graph',
      'trend',
      'activity',
      'pulse',
      'gauge',
    ],
  },
  {
    name: 'Maps & Places',
    prefixes: ['map', 'compass', 'locate', 'pin', 'flag', 'milestone', 'earth', 'globe', 'road'],
  },
  {
    name: 'Weather & Nature',
    prefixes: [
      'sun',
      'moon',
      'cloud',
      'rain',
      'snow',
      'wind',
      'thunder',
      'lightning',
      'star',
      'leaf',
      'tree',
      'flower',
      'mountain',
      'wave',
      'droplet',
    ],
  },
  {
    name: 'People & Users',
    prefixes: ['user', 'users', 'person', 'people', 'contact', 'team', 'group', 'account'],
  },
  {
    name: 'Security',
    prefixes: ['lock', 'unlock', 'key', 'shield', 'security', 'fingerprint', 'badge'],
  },
  {
    name: 'Text & Formatting',
    prefixes: ['align', 'text', 'type', 'font', 'heading', 'bold', 'italic', 'quote', 'list'],
  },
  {
    name: 'Code & Development',
    prefixes: [
      'code',
      'terminal',
      'git',
      'github',
      'database',
      'package',
      'bug',
      'braces',
      'brackets',
      'variable',
      'function',
      'webhook',
      'binary',
      'container',
      'workflow',
      'network',
      'bot',
      'cpu',
    ],
  },
  {
    name: 'Shopping & Finance',
    prefixes: [
      'shopping',
      'cart',
      'bag',
      'store',
      'dollar',
      'euro',
      'pound',
      'coin',
      'credit',
      'wallet',
      'receipt',
      'ticket',
      'discount',
    ],
  },
  {
    name: 'Time & Calendar',
    prefixes: ['clock', 'calendar', 'timer', 'alarm', 'history', 'hourglass', 'time', 'watch'],
  },
  {
    name: 'Social',
    prefixes: ['share', 'thumbs', 'facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'rss'],
  },
  {
    name: 'Shapes',
    prefixes: ['circle', 'square', 'triangle', 'octagon', 'pentagon', 'diamond', 'hexagon'],
  },
  {
    name: 'Editing & Tools',
    prefixes: [
      'pencil',
      'pen',
      'edit',
      'scissors',
      'crop',
      'eraser',
      'trash',
      'delete',
      'undo',
      'redo',
      'rotate',
      'flip',
      'zoom',
      'filter',
      'funnel',
      'ruler',
      'wrench',
      'tool',
      'hammer',
      'screwdriver',
      'settings',
      'sliders',
      'wand',
      'paintbrush',
    ],
  },
  {
    name: 'Layout & UI',
    prefixes: [
      'layout',
      'panel',
      'sidebar',
      'columns',
      'rows',
      'grid',
      'table',
      'card',
      'window',
      'app',
      'layers',
      'frame',
      'expand',
      'shrink',
      'minimize',
      'maximize',
      'split',
      'merge',
      'anchor',
      'dock',
      'divider',
      'separator',
      'menu',
    ],
  },
  {
    name: 'Travel & Transport',
    prefixes: [
      'car',
      'truck',
      'bus',
      'train',
      'plane',
      'ship',
      'bike',
      'fuel',
      'parking',
      'road',
      'luggage',
      'tent',
      'aircraft',
      'sailboat',
    ],
  },
  {
    name: 'Food & Drink',
    prefixes: [
      'coffee',
      'tea',
      'beer',
      'wine',
      'apple',
      'pizza',
      'cake',
      'cookie',
      'egg',
      'fish',
      'utensils',
      'salad',
      'milk',
      'grape',
      'banana',
      'lemon',
    ],
  },
  {
    name: 'Health & Medical',
    prefixes: [
      'stethoscope',
      'pill',
      'syringe',
      'hospital',
      'thermometer',
      'band',
      'microscope',
      'flask',
      'dna',
      'virus',
      'accessibility',
    ],
  },
];

/** Derive a display category from a kebab-case icon name. */
function categoryFor(kebab: string): string {
  for (const rule of CATEGORY_RULES) {
    for (const prefix of rule.prefixes) {
      if (kebab === prefix || kebab.startsWith(`${prefix}-`)) {
        return rule.name;
      }
    }
  }
  return 'Other';
}

/**
 * Build the flat list of all Lucide icon entries from the set of PascalCase export names
 * (`Object.keys(lucideExports)`). `tagsMap` is lucide-static's `tags.json`.
 *
 * Digit-normalization gotcha: `toKebabCase` does NOT hyphenate digit boundaries (`Trash2`
 * → `trash2`) but `tags.json` uses the canonical `trash-2`. The lookup strips hyphens
 * around digits on both sides so `trash2` resolves to `trash-2`'s tags.
 */
export function buildIconEntries(
  pascalNames: string[],
  tagsMap: Record<string, string[]> = {},
): IconEntry[] {
  // Strip digit-adjacent hyphens from tagsMap keys so they match toKebabCase's output.
  // e.g.  "trash-2" → "trash2",  "arrow-down-0-1" → "arrow-down-01"
  const normalizedTagsMap = new Map<string, string[]>();
  for (const [key, val] of Object.entries(tagsMap)) {
    const norm = key.replace(/-(\d)/g, '$1').replace(/(\d)-/g, '$1');
    normalizedTagsMap.set(norm, val);
  }

  const seenKebabs = new Set<string>();
  return (
    pascalNames
      .filter((k) => {
        if (k.endsWith('Icon')) return false;
        if (['createLucideIcon', 'LucideProvider', 'default'].includes(k)) return false;
        // A real icon always has a matching 'XxxIcon' alias — a reliable guard.
        return pascalNames.includes(`${k}Icon`);
      })
      .map((pascal) => {
        const kebab = toKebabCase(pascal);
        return {
          pascal,
          kebab,
          category: categoryFor(kebab),
          tags: normalizedTagsMap.get(kebab) ?? [],
        };
      })
      // De-duplicate by kebab: lucide-react ships both `ArrowDownAZ` and `ArrowDownAz`,
      // both converting to `arrow-down-az`. Keep the first occurrence.
      .filter((entry) => {
        if (seenKebabs.has(entry.kebab)) return false;
        seenKebabs.add(entry.kebab);
        return true;
      })
      .sort((a, b) => a.kebab.localeCompare(b.kebab))
  );
}

export interface IconGroup {
  category: string;
  entries: IconEntry[];
}

/** Count of icons shown for a query (all entries when empty); drives the footer count. */
export function countFilteredIcons(entries: IconEntry[], query: string): number {
  const q = query.trim().toLowerCase().replace(/\s+/g, '-');
  if (!q) return entries.length;
  return entries.filter(
    (e) => e.kebab.includes(q) || e.tags.some((tag) => tag.toLowerCase().includes(q)),
  ).length;
}

export function filterAndGroupIcons(entries: IconEntry[], query: string): IconGroup[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, '-');
  if (q) {
    const filtered = entries.filter(
      (e) => e.kebab.includes(q) || e.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
    return filtered.length > 0 ? [{ category: '', entries: filtered }] : [];
  }

  const categoryOrder = [...CATEGORY_RULES.map((r) => r.name), 'Other'];
  const byCategory = new Map<string, IconEntry[]>();
  for (const entry of entries) {
    const arr = byCategory.get(entry.category) ?? [];
    arr.push(entry);
    byCategory.set(entry.category, arr);
  }
  const groups: IconGroup[] = [];
  for (const cat of categoryOrder) {
    const catEntries = byCategory.get(cat);
    if (catEntries && catEntries.length > 0) {
      groups.push({ category: cat, entries: catEntries });
    }
  }
  return groups;
}
