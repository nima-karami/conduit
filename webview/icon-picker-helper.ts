/**
 * Pure helpers for the icon-picker modal (D3). These are logic-only — no DOM / JSX /
 * React — so they can be unit-tested in the node environment (no jsdom needed).
 *
 * The lucide-react 1.18.0 package ships no tag or category metadata in its dist.
 * Categories are therefore derived from well-known naming prefixes. Coverage is
 * pragmatic: the common icon groups are named; icons that do not match any prefix land
 * in "Other". Search works across the full kebab-case name for all icons (including
 * the uncategorised ones), so no icon is ever unreachable.
 */

/**
 * One entry in the flat icon list that the picker works with.
 * `kebab` — the kebab-case icon name (matches Lucide's file names + the value stored in
 *            Session.iconOverride).
 * `pascal` — the PascalCase export name from lucide-react (used to look up the component).
 * `category` — display group for the category-section view.
 */
export interface IconEntry {
  kebab: string;
  pascal: string;
  category: string;
}

/** Convert PascalCase → kebab-case. Handles consecutive capitals (e.g. ALargeSmall → a-large-small). */
export function toKebabCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2') // e.g. ALarge → A-Large
    .replace(/([a-z])([A-Z])/g, '$1-$2') // e.g. argeSmall → arge-Small
    .toLowerCase();
}

/** Convert kebab-case → PascalCase. */
export function toPascalCase(s: string): string {
  return s
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Category ordering and prefix rules. Each category lists the kebab-case prefixes that
 * belong to it (matched as exact prefix: `chevron-` or exact name: `chevron`). The
 * FIRST matching category wins; "Other" is the catch-all.
 *
 * NOTE: lucide-react 1.18.0 ships no official category metadata — this is a best-effort
 * mapping from naming conventions. Reported as a fork in the build report.
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
 * Build the flat list of all Lucide icon entries from the set of PascalCase export names.
 * The caller should pass `Object.keys(lucideExports)` filtered to actual icon components.
 *
 * Exported for unit testing; the real picker imports lucide-react and calls this once at
 * module load time to build the stable list.
 */
export function buildIconEntries(pascalNames: string[]): IconEntry[] {
  return pascalNames
    .filter((k) => {
      // Skip aliases (keys that end in 'Icon'), utility exports, and non-icon functions.
      if (k.endsWith('Icon')) return false;
      if (['createLucideIcon', 'LucideProvider', 'default'].includes(k)) return false;
      // A real icon has a matching 'XxxIcon' alias in lucide-react.
      // This is a reliable guard since lucide always exports both.
      return pascalNames.includes(`${k}Icon`);
    })
    .map((pascal) => {
      const kebab = toKebabCase(pascal);
      return { pascal, kebab, category: categoryFor(kebab) };
    })
    .sort((a, b) => a.kebab.localeCompare(b.kebab));
}

/**
 * Filter and group icon entries for the picker UI.
 *
 * When `query` is non-empty, returns a single flat group `{ category: '', entries }` with
 * all icons whose kebab name contains the query (case-insensitive). When `query` is empty,
 * returns icons grouped by their category in display order.
 */
export interface IconGroup {
  category: string;
  entries: IconEntry[];
}

export function filterAndGroupIcons(entries: IconEntry[], query: string): IconGroup[] {
  const q = query.trim().toLowerCase();
  if (q) {
    const filtered = entries.filter((e) => e.kebab.includes(q));
    return filtered.length > 0 ? [{ category: '', entries: filtered }] : [];
  }

  // Group by category, preserving CATEGORY_RULES order (Other goes last).
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
