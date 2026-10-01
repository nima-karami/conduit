// Hand-rolled because mermaid ships a renderer, not a graph you can read back out of it.
// Span-preserving: every statement keeps its line so an edit can re-emit only what it touches —
// docs/specs/2026-09-30-interactive-plan-v2.md §3.2. Edits live in `mermaid-flow-edit.ts`.

export type FlowDirection = 'TB' | 'TD' | 'BT' | 'LR' | 'RL';
export type FlowShape =
  | 'rect'
  | 'round'
  | 'stadium'
  | 'subroutine'
  | 'diamond'
  | 'circle'
  | 'cylinder'
  | 'hexagon';
export type FlowEdgeKind = 'arrow' | 'open' | 'dotted' | 'thick' | 'bidir';

/** 0-based fence line; character offsets into that line. */
export interface FlowSpan {
  line: number;
  start: number;
  end: number;
}

export interface FlowNode {
  id: string;
  label: string;
  parent: string | null;
  /** 'verbatim' = `>x]` `[/x/]` `[\x\]` `[/x\]` `[\x/]`: kept as written, never re-emitted. */
  shape: FlowShape | 'verbatim';
  /** The first mention carrying a label or shape, else the first mention. */
  def: FlowSpan;
  /** Decides membership (spec §3.2). */
  first: FlowSpan;
}

export interface FlowEdge {
  source: string;
  target: string;
  kind: FlowEdgeKind;
  label: string | null;
  /** Statement index. */
  stmt: number;
  /** Link index inside the statement's chain. */
  link: number;
}

export interface FlowSubgraph {
  id: string;
  title: string;
  parent: string | null;
  /** Lines of the `subgraph` header and its `end`. */
  open: number;
  close: number;
}

export type FlowStatementKind =
  | 'header'
  | 'blank'
  | 'comment'
  | 'chain'
  | 'subgraph'
  | 'end'
  | 'trailer';

export interface FlowStatement {
  kind: FlowStatementKind;
  line: number;
  indent: string;
  /** The enclosing subgraph; a `subgraph`/`end` line sits in its parent's scope. */
  scope: string | null;
  /** Chain only: `refs.length === links.length + 1`. */
  refs: FlowSpan[];
  links: FlowSpan[];
}

export interface FlowGraph {
  keyword: 'flowchart' | 'graph';
  direction: FlowDirection;
  nodes: FlowNode[];
  /** Source order — `linkStyle` indices count in it. */
  edges: FlowEdge[];
  subgraphs: FlowSubgraph[];
}

export interface FlowDoc {
  lines: string[];
  eol: '\n' | '\r\n';
  statements: FlowStatement[];
  graph: FlowGraph;
}

export type FlowParse = { ok: true; doc: FlowDoc } | { ok: false; reason: string; line: number };

const HEADER_RE = /^(flowchart|graph)[ \t]+(TB|TD|BT|LR|RL)$/;
const TRAILER_RE = /^(classDef|class|style|click|linkStyle)[ \t]/;
const SUBGRAPH_RE = /^subgraph([ \t]|$)/;
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*/;
const FULL_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const ENTITY_RE = /#(quot|35);/g;

/** Mermaid's own entity escapes; a quoted label cannot hold a bare `"`. */
const decodeLabel = (text: string): string =>
  text.replace(ENTITY_RE, (_m, name: string) => (name === 'quot' ? '"' : '#'));

export const FLOW_SHAPE_TOKENS: Record<FlowShape, { open: string; close: string }> = {
  rect: { open: '[', close: ']' },
  round: { open: '(', close: ')' },
  stadium: { open: '([', close: '])' },
  subroutine: { open: '[[', close: ']]' },
  diamond: { open: '{', close: '}' },
  circle: { open: '((', close: '))' },
  cylinder: { open: '[(', close: ')]' },
  hexagon: { open: '{{', close: '}}' },
};

export const FLOW_ARROWS: Record<FlowEdgeKind, string> = {
  arrow: '-->',
  open: '---',
  dotted: '-.->',
  thick: '==>',
  bidir: '<-->',
};

interface ShapeForm {
  open: string;
  /** Several closers for the slanted verbatim forms; the earliest one wins. */
  close: string[];
  shape: FlowShape | 'verbatim';
}

const sym = (shape: FlowShape): ShapeForm => ({
  open: FLOW_SHAPE_TOKENS[shape].open,
  close: [FLOW_SHAPE_TOKENS[shape].close],
  shape,
});

// Longest openers first: `[(` / `[[` / `[/` must win over `[`, `((` / `([` over `(`.
const FORMS: ShapeForm[] = [
  sym('stadium'),
  sym('subroutine'),
  sym('cylinder'),
  { open: '[/', close: ['/]', '\\]'], shape: 'verbatim' },
  { open: '[\\', close: ['\\]', '/]'], shape: 'verbatim' },
  sym('circle'),
  sym('hexagon'),
  sym('rect'),
  sym('round'),
  sym('diamond'),
  { open: '>', close: [']'], shape: 'verbatim' },
];

const CONNECTORS: { text: string; kind: FlowEdgeKind }[] = (
  ['bidir', 'dotted', 'thick', 'arrow', 'open'] as const
).map((kind) => ({ text: FLOW_ARROWS[kind], kind }));

export interface FlowRef {
  id: string;
  label: string | null;
  shape: FlowShape | 'verbatim';
  open: string;
  close: string;
  /** Offset just past the ref. */
  next: number;
}

/** Reads one node mention (`id`, `id[Label]`, `id(["x"])` …) starting at `at`. */
export function readFlowRef(line: string, at = 0): FlowRef | null {
  const id = ID_RE.exec(line.slice(at));
  if (!id) return null;
  const start = at + id[0].length;
  for (const form of FORMS) {
    if (!line.startsWith(form.open, start)) continue;
    let p = start + form.open.length;
    let label: string;
    let close: string;
    if (line[p] === '"') {
      const quote = line.indexOf('"', p + 1);
      if (quote < 0) return null;
      const closer = form.close.find((c) => line.startsWith(c, quote + 1));
      if (closer === undefined) return null;
      label = decodeLabel(line.slice(p + 1, quote));
      close = closer;
      p = quote + 1 + closer.length;
    } else {
      let best = -1;
      let closer = '';
      for (const c of form.close) {
        const i = line.indexOf(c, p);
        if (i >= 0 && (best < 0 || i < best)) {
          best = i;
          closer = c;
        }
      }
      if (best < 0) return null;
      label = decodeLabel(line.slice(p, best).trim());
      close = closer;
      p = best + closer.length;
    }
    return { id: id[0], label, shape: form.shape, open: form.open, close, next: p };
  }
  return { id: id[0], label: null, shape: 'rect', open: '', close: '', next: start };
}

interface Link {
  kind: FlowEdgeKind;
  label: string | null;
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';

function unquote(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? decodeLabel(text.slice(1, -1))
    : decodeLabel(text.trim());
}

function readConnector(line: string, at: number): { link: Link; next: number } | null {
  if (line.startsWith('--', at) && isSpace(line[at + 2])) {
    const text = /^[ \t]+(.*?)[ \t]+(-->|---)/.exec(line.slice(at + 2));
    if (!text) return null;
    return {
      link: { kind: text[2] === '-->' ? 'arrow' : 'open', label: unquote(text[1]) || null },
      next: at + 2 + text[0].length,
    };
  }
  for (const c of CONNECTORS) {
    if (!line.startsWith(c.text, at)) continue;
    let p = at + c.text.length;
    let label: string | null = null;
    if (line[p] === '|') {
      // A quoted edge label is the only form that can carry a `|`, so the closing delimiter is
      // the one after the closing quote — not the first `|` found.
      if (line[p + 1] === '"') {
        const quote = line.indexOf('"', p + 2);
        if (quote < 0 || line[quote + 1] !== '|') return null;
        label = decodeLabel(line.slice(p + 2, quote)) || null;
        p = quote + 2;
      } else {
        const close = line.indexOf('|', p + 1);
        if (close < 0) return null;
        label = decodeLabel(line.slice(p + 1, close).trim()) || null;
        p = close + 1;
      }
    }
    return { link: { kind: c.kind, label }, next: p };
  }
  return null;
}

interface Scanned {
  refs: { ref: FlowRef; span: FlowSpan }[];
  links: { link: Link; span: FlowSpan }[];
}

function scanChain(line: string, lineNo: number, from: number): Scanned | null {
  const first = readFlowRef(line, from);
  if (!first) return null;
  const out: Scanned = {
    refs: [{ ref: first, span: { line: lineNo, start: from, end: first.next } }],
    links: [],
  };
  let at = first.next;
  while (at < line.length) {
    const beforeGap = at;
    while (isSpace(line[at])) at++;
    // Every token is whitespace-separated: `a-->b` and `a -->|x|b` are out of the subset.
    if (at === beforeGap) return null;
    const connector = readConnector(line, at);
    if (!connector) return null;
    out.links.push({
      link: connector.link,
      span: { line: lineNo, start: at, end: connector.next },
    });
    at = connector.next;
    const afterGap = at;
    while (isSpace(line[at])) at++;
    if (at === afterGap) return null;
    const target = readFlowRef(line, at);
    if (!target) return null;
    out.refs.push({ ref: target, span: { line: lineNo, start: at, end: target.next } });
    at = target.next;
  }
  return out;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readSubgraph(rest: string): { id: string; title: string } | null {
  if (rest.startsWith('"')) {
    const quote = rest.indexOf('"', 1);
    if (quote < 0 || rest.slice(quote + 1).trim()) return null;
    const title = decodeLabel(rest.slice(1, quote));
    const id = slug(title);
    return id && FULL_ID_RE.test(id) ? { id, title } : null;
  }
  const id = ID_RE.exec(rest);
  if (!id) return null;
  const tail = rest.slice(id[0].length).trim();
  if (!tail) return { id: id[0], title: id[0] };
  if (!tail.startsWith('[') || !tail.endsWith(']')) return null;
  return { id: id[0], title: unquote(tail.slice(1, -1).trim()) };
}

export function parseFlowchart(source: string): FlowParse {
  const fail = (reason: string, line: number): FlowParse => ({ ok: false, reason, line });
  const lines = source.split(/\r?\n/);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const statements: FlowStatement[] = [];
  const nodes: FlowNode[] = [];
  const byId = new Map<string, FlowNode>();
  const labelled = new Set<string>();
  const edges: FlowEdge[] = [];
  const subgraphs: FlowSubgraph[] = [];
  const subById = new Map<string, FlowSubgraph>();
  const open: FlowSubgraph[] = [];
  let keyword: 'flowchart' | 'graph' | null = null;
  let direction: FlowDirection = 'LR';

  for (let i = 0; i < lines.length; i++) {
    const content = lines[i].trimEnd();
    const indent = /^[ \t]*/.exec(content)?.[0] ?? '';
    const text = content.slice(indent.length);
    const at = i + 1;
    const scope = open.length ? open[open.length - 1].id : null;
    const push = (kind: FlowStatementKind, s: string | null = scope): void => {
      statements.push({ kind, line: i, indent, scope: s, refs: [], links: [] });
    };

    if (!text) {
      push('blank');
      continue;
    }
    if (text.startsWith('%%')) {
      push('comment');
      continue;
    }

    if (!keyword) {
      const header = HEADER_RE.exec(text);
      if (!header) return fail('expected a flowchart or graph header', at);
      keyword = header[1] as 'flowchart' | 'graph';
      direction = header[2] as FlowDirection;
      push('header');
      continue;
    }

    if (text === 'end') {
      const closing = open.pop();
      if (!closing) return fail('end without an open subgraph', at);
      closing.close = i;
      push('end', closing.parent);
      continue;
    }

    if (SUBGRAPH_RE.test(text)) {
      const head = readSubgraph(text.slice('subgraph'.length).trim());
      if (!head) return fail('unsupported subgraph header', at);
      if (subById.has(head.id) || byId.has(head.id)) return fail('duplicate id', at);
      const sub: FlowSubgraph = { ...head, parent: scope, open: i, close: -1 };
      subgraphs.push(sub);
      subById.set(sub.id, sub);
      open.push(sub);
      push('subgraph');
      continue;
    }

    if (TRAILER_RE.test(text)) {
      push('trailer');
      continue;
    }

    const scanned = scanChain(content, i, indent.length);
    if (!scanned) return fail('unsupported syntax', at);
    const stmt = statements.length;
    statements.push({
      kind: 'chain',
      line: i,
      indent,
      scope,
      refs: scanned.refs.map((r) => r.span),
      links: scanned.links.map((l) => l.span),
    });
    for (const { ref, span } of scanned.refs) {
      if (subById.has(ref.id)) continue;
      const existing = byId.get(ref.id);
      if (!existing) {
        const node: FlowNode = {
          id: ref.id,
          label: ref.label ?? ref.id,
          parent: scope,
          shape: ref.label === null ? 'rect' : ref.shape,
          def: span,
          first: span,
        };
        nodes.push(node);
        byId.set(ref.id, node);
        if (ref.label !== null) labelled.add(ref.id);
      } else if (ref.label !== null && !labelled.has(ref.id)) {
        existing.label = ref.label;
        existing.shape = ref.shape;
        existing.def = span;
        labelled.add(ref.id);
      }
    }
    scanned.links.forEach(({ link }, k) => {
      edges.push({
        source: scanned.refs[k].ref.id,
        target: scanned.refs[k + 1].ref.id,
        kind: link.kind,
        label: link.label,
        stmt,
        link: k,
      });
    });
  }

  if (!keyword) return fail('expected a flowchart or graph header', 1);
  const unclosed = open[open.length - 1];
  if (unclosed) return fail('unclosed subgraph', unclosed.open + 1);
  return {
    ok: true,
    doc: { lines, eol, statements, graph: { keyword, direction, nodes, edges, subgraphs } },
  };
}
