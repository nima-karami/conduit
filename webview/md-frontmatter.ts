/**
 * remarkFrontmatterCard — render leading YAML frontmatter as a metadata card.
 *
 * `remark-frontmatter` parses a leading `---`…`---` block into a `yaml` mdast node
 * (otherwise dropped from output). This plugin replaces that node with a
 * `div.markdown-frontmatter` of key/value rows. A doc with no frontmatter has no
 * `yaml` node, so this is a no-op there (byte-identical output).
 *
 * The YAML parse is deliberately minimal — flat `key: value` pairs + simple block
 * lists, the 95% case for doc frontmatter. It is NOT a YAML engine: unrecognized
 * lines are skipped, never thrown, so a malformed block never blanks the doc. A real
 * YAML dependency can replace `parseFrontmatter` later if demand appears.
 */

/** Strip matching surrounding quotes from a scalar value. */
function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Normalize an inline `[a, b]` flow sequence to `a, b`. */
function flowList(v: string): string {
  return v
    .slice(1, -1)
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter(Boolean)
    .join(', ');
}

/**
 * Parse flat YAML frontmatter into ordered [key, value] pairs. Handles scalars,
 * quoted values, inline `[a, b]` lists, and block lists (`key:` then `  - item`).
 */
export function parseFrontmatter(yaml: string): Array<[string, string]> {
  const lines = yaml.replace(/\r/g, '').split('\n');
  const pairs: Array<[string, string]> = [];
  // A `key:` with an empty value may head a block list. Remember the key; its pair is
  // created lazily when the first `- item` arrives, so a value-less key that collects
  // nothing is simply never added (no push-then-filter).
  let listKey: { key: string; idx: number } | null = null;

  for (const line of lines) {
    if (line.trim() === '') continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listKey) {
      const item = unquote(listItem[1]);
      if (listKey.idx === -1) {
        pairs.push([listKey.key, item]);
        listKey.idx = pairs.length - 1;
      } else {
        pairs[listKey.idx][1] += `, ${item}`;
      }
      continue;
    }

    const kv = /^([A-Za-z0-9_.\- ]+?):\s*(.*)$/.exec(line);
    if (!kv) {
      listKey = null;
      continue;
    }
    const key = kv[1].trim();
    let value = kv[2].trim();
    if (value === '') {
      listKey = { key, idx: -1 };
      continue;
    }
    value = value.startsWith('[') && value.endsWith(']') ? flowList(value) : unquote(value);
    pairs.push([key, value]);
    listKey = null;
  }

  return pairs;
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

function span(className: string, value: string): MdNode {
  return {
    type: 'emphasis',
    data: { hName: 'span', hProperties: { className: [className] } },
    children: [{ type: 'text', value }],
  };
}

function row(key: string, value: string): MdNode {
  return {
    type: 'paragraph',
    data: { hName: 'div', hProperties: { className: ['markdown-frontmatter__row'] } },
    children: [span('markdown-frontmatter__key', key), span('markdown-frontmatter__val', value)],
  };
}

function card(pairs: Array<[string, string]>): MdNode {
  return {
    type: 'blockquote',
    data: { hName: 'div', hProperties: { className: ['markdown-frontmatter'] } },
    children: pairs.map(([k, v]) => row(k, v)),
  };
}

/** remark plugin entry. Place AFTER remark-frontmatter (which creates the yaml node). */
export function remarkFrontmatterCard() {
  return (tree: MdNode): void => {
    const children = tree.children;
    if (!children) return;
    const idx = children.findIndex((c) => c.type === 'yaml');
    if (idx === -1) return;
    const pairs = parseFrontmatter(children[idx].value ?? '');
    if (pairs.length === 0) {
      children.splice(idx, 1); // empty frontmatter → drop it (no stray hr/text)
      return;
    }
    children[idx] = card(pairs);
  };
}
