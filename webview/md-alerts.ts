/**
 * remarkAlerts — GitHub-style alert/admonition support for the Markdown viewer.
 *
 * Turns a blockquote whose first line is `[!NOTE]` (or TIP/IMPORTANT/WARNING/CAUTION)
 * into a themed callout: a `div.markdown-alert.markdown-alert-<type>` with a
 * `div.markdown-alert-title` (icon via CSS + label) ahead of the body. Plain
 * blockquotes are left untouched.
 *
 * Dep-free (mirrors md-reveal.ts): minimal mdast types inline, a hand-rolled walker,
 * no unist-util-visit. The detection helpers are pure so they unit-test without a DOM.
 */

const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

const MARKER_RE = /^\[!(note|tip|important|warning|caution)\]/i;

/** The alert type named by a leading `[!TYPE]` marker, or null when absent/unknown. */
export function matchAlertType(text: string): AlertType | null {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  return m[1].toLowerCase() as AlertType;
}

/** GitHub's title-cased label for a type ("note" → "Note"). */
export function alertLabel(type: AlertType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

interface MdText {
  type: 'text';
  value: string;
}
interface MdParent {
  type: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}
type MdNode = MdText | MdParent;

function isText(n: MdNode): n is MdText {
  return n.type === 'text';
}
function isParent(n: MdNode): n is MdParent {
  return 'children' in n && Array.isArray((n as MdParent).children);
}

/** Build the title node (`div.markdown-alert-title` carrying the label). */
function makeTitle(type: AlertType): MdParent {
  return {
    type: 'paragraph',
    data: { hName: 'div', hProperties: { className: ['markdown-alert-title'] } },
    children: [{ type: 'text', value: alertLabel(type) }],
  };
}

/** Convert one blockquote into an alert in place if it carries a marker. Returns true
 *  when transformed. */
function transformBlockquote(node: MdParent): boolean {
  const first = node.children?.[0];
  if (!first || !isParent(first) || first.type !== 'paragraph') return false;
  const firstText = first.children?.[0];
  if (!firstText || !isText(firstText)) return false;

  const type = matchAlertType(firstText.value);
  if (!type) return false;

  // Strip the marker and an immediately-following newline from the body.
  firstText.value = firstText.value.replace(/^\[!\w+\]\r?\n?/i, '');
  // A marker-only blockquote leaves an empty paragraph — drop it so the callout has
  // just a title.
  if (firstText.value === '' && first.children?.length === 1) {
    node.children?.shift();
  }

  node.data = node.data ?? {};
  node.data.hName = 'div';
  node.data.hProperties = {
    className: ['markdown-alert', `markdown-alert-${type}`],
    role: 'note',
  };
  node.children?.unshift(makeTitle(type));
  return true;
}

function walk(node: MdNode): void {
  if (!isParent(node)) return;
  if (node.type === 'blockquote') {
    transformBlockquote(node);
    // A transformed alert may still contain nested blockquotes in its body; keep
    // walking its children either way.
  }
  for (const child of node.children ?? []) {
    walk(child);
  }
}

/** remark plugin entry. Add to `remarkPlugins`. */
export function remarkAlerts() {
  return (tree: MdParent): void => {
    walk(tree);
  };
}
