// Hand-rolled because mermaid ships a renderer, not a graph you can read back out of it.
// Supported subset + canonical output: docs/plans/2026-09-19-interactive-plan.plan.md, Contracts.

export type FlowDirection = 'TB' | 'TD' | 'BT' | 'LR' | 'RL';
export type FlowShape = 'rect' | 'round' | 'stadium' | 'subroutine' | 'diamond' | 'circle';
export type FlowEdgeKind = 'arrow' | 'open' | 'dotted' | 'thick' | 'bidir';

export interface FlowNode {
  id: string;
  label: string;
  shape: FlowShape;
  parent: string | null;
}

export interface FlowEdge {
  source: string;
  target: string;
  kind: FlowEdgeKind;
  label: string | null;
}

export interface FlowSubgraph {
  id: string;
  title: string;
  parent: string | null;
}

export interface FlowGraph {
  keyword: 'flowchart' | 'graph';
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
  subgraphs: FlowSubgraph[];
  trailer: string[];
}

export type FlowParse =
  | { ok: true; graph: FlowGraph }
  | { ok: false; reason: string; line: number };

const HEADER_RE = /^(flowchart|graph)[ \t]+(TB|TD|BT|LR|RL)$/;
const TRAILER_RE = /^(classDef|class|style|click|linkStyle)[ \t]/;
const SUBGRAPH_RE = /^subgraph([ \t]|$)/;
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*/;
const FULL_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const QUOTE_RE = /["[\]{}()|]/;
// A quoted label cannot contain a bare `"`; mermaid's own entity escape is the only way through.
const QUOT_ENTITY = '#quot;';
const QUOT_ENTITY_RE = /#quot;/g;

const unquoteLabel = (text: string): string => text.replace(QUOT_ENTITY_RE, '"');

const SHAPES: { open: string; close: string; shape: FlowShape }[] = [
  { open: '([', close: '])', shape: 'stadium' },
  { open: '[[', close: ']]', shape: 'subroutine' },
  { open: '((', close: '))', shape: 'circle' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
  { open: '{', close: '}', shape: 'diamond' },
];

const CONNECTORS: { text: string; kind: FlowEdgeKind }[] = [
  { text: '<-->', kind: 'bidir' },
  { text: '-.->', kind: 'dotted' },
  { text: '==>', kind: 'thick' },
  { text: '-->', kind: 'arrow' },
  { text: '---', kind: 'open' },
];

const ARROWS: Record<FlowEdgeKind, string> = {
  arrow: '-->',
  open: '---',
  dotted: '-.->',
  thick: '==>',
  bidir: '<-->',
};

interface NodeRef {
  id: string;
  label: string | null;
  shape: FlowShape;
}

interface Link {
  kind: FlowEdgeKind;
  label: string | null;
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';

function readNodeRef(line: string, at: number): { ref: NodeRef; next: number } | null {
  const id = ID_RE.exec(line.slice(at));
  if (!id) return null;
  const start = at + id[0].length;
  for (const s of SHAPES) {
    if (!line.startsWith(s.open, start)) continue;
    let p = start + s.open.length;
    let label: string;
    if (line[p] === '"') {
      const quote = line.indexOf('"', p + 1);
      if (quote < 0) return null;
      label = unquoteLabel(line.slice(p + 1, quote));
      p = quote + 1;
      if (!line.startsWith(s.close, p)) return null;
      p += s.close.length;
    } else {
      const close = line.indexOf(s.close, p);
      if (close < 0) return null;
      label = line.slice(p, close).trim();
      p = close + s.close.length;
    }
    return { ref: { id: id[0], label, shape: s.shape }, next: p };
  }
  return { ref: { id: id[0], label: null, shape: 'rect' }, next: start };
}

function readConnector(line: string, at: number): { link: Link; next: number } | null {
  if (line.startsWith('--', at) && isSpace(line[at + 2])) {
    const text = /^[ \t]+(.*?)[ \t]+(-->|---)/.exec(line.slice(at + 2));
    if (!text) return null;
    return {
      link: { kind: text[2] === '-->' ? 'arrow' : 'open', label: text[1].trim() || null },
      next: at + 2 + text[0].length,
    };
  }
  for (const c of CONNECTORS) {
    if (!line.startsWith(c.text, at)) continue;
    let p = at + c.text.length;
    let label: string | null = null;
    if (line[p] === '|') {
      const close = line.indexOf('|', p + 1);
      if (close < 0) return null;
      label = line.slice(p + 1, close).trim() || null;
      p = close + 1;
    }
    return { link: { kind: c.kind, label }, next: p };
  }
  return null;
}

function scanLine(line: string): { refs: NodeRef[]; links: Link[] } | null {
  const first = readNodeRef(line, 0);
  if (!first) return null;
  const refs = [first.ref];
  const links: Link[] = [];
  let at = first.next;
  while (at < line.length) {
    const beforeGap = at;
    while (isSpace(line[at])) at++;
    // Every token is whitespace-separated: `a-->b` and `a -->|x|b` are out of the subset.
    if (at === beforeGap) return null;
    const connector = readConnector(line, at);
    if (!connector) return null;
    at = connector.next;
    const afterGap = at;
    while (isSpace(line[at])) at++;
    if (at === afterGap) return null;
    const target = readNodeRef(line, at);
    if (!target) return null;
    refs.push(target.ref);
    links.push(connector.link);
    at = target.next;
  }
  return { refs, links };
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unquote(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? unquoteLabel(text.slice(1, -1))
    : text.trim();
}

function readSubgraph(rest: string): { id: string; title: string } | null {
  if (rest.startsWith('"')) {
    const quote = rest.indexOf('"', 1);
    if (quote < 0 || rest.slice(quote + 1).trim()) return null;
    const title = rest.slice(1, quote);
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

// Array order is part of deep equality, so parse and every reducer settle on the one order
// serializeFlowchart emits: subgraphs depth-first, nodes grouped by owner, loose nodes last.
function canonical(g: FlowGraph): FlowGraph {
  const subgraphs: FlowSubgraph[] = [];
  const walk = (parent: string | null): void => {
    for (const s of g.subgraphs) {
      if (s.parent !== parent) continue;
      subgraphs.push(s);
      walk(s.id);
    }
  };
  walk(null);
  const placed = new Set(subgraphs);
  for (const s of g.subgraphs) if (!placed.has(s)) subgraphs.push(s);

  const nodes: FlowNode[] = [];
  const owners = [...subgraphs.map((s) => s.id), null];
  for (const owner of owners) for (const n of g.nodes) if (n.parent === owner) nodes.push(n);
  const kept = new Set(nodes);
  for (const n of g.nodes) if (!kept.has(n)) nodes.push(n);

  return { ...g, subgraphs, nodes };
}

export function parseFlowchart(source: string): FlowParse {
  const fail = (reason: string, line: number): FlowParse => ({ ok: false, reason, line });
  const lines = source.split(/\r?\n/);
  const nodes: FlowNode[] = [];
  const byId = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const subgraphs: FlowSubgraph[] = [];
  const subgraphIds = new Set<string>();
  const trailer: string[] = [];
  const open: { id: string; line: number }[] = [];
  let keyword: 'flowchart' | 'graph' | null = null;
  let direction: FlowDirection = 'LR';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const at = i + 1;
    if (!line || line.startsWith('%%')) continue;

    if (!keyword) {
      const header = HEADER_RE.exec(line);
      if (!header) return fail('expected a flowchart or graph header', at);
      keyword = header[1] as 'flowchart' | 'graph';
      direction = header[2] as FlowDirection;
      continue;
    }

    if (line === 'end') {
      if (!open.length) return fail('end without an open subgraph', at);
      open.pop();
      continue;
    }

    const parent = open.length ? open[open.length - 1].id : null;

    if (SUBGRAPH_RE.test(line)) {
      const head = readSubgraph(line.slice('subgraph'.length).trim());
      if (!head) return fail('unsupported subgraph header', at);
      if (subgraphIds.has(head.id) || byId.has(head.id)) return fail('duplicate id', at);
      subgraphs.push({ id: head.id, title: head.title, parent });
      subgraphIds.add(head.id);
      open.push({ id: head.id, line: at });
      continue;
    }

    if (TRAILER_RE.test(line)) {
      trailer.push(line);
      continue;
    }

    const scanned = scanLine(line);
    if (!scanned) return fail('unsupported syntax', at);
    for (const ref of scanned.refs) {
      const existing = byId.get(ref.id);
      if (existing) {
        if (ref.label !== null) {
          existing.label = ref.label;
          existing.shape = ref.shape;
        }
        continue;
      }
      if (subgraphIds.has(ref.id)) continue;
      const node: FlowNode = { id: ref.id, label: ref.label ?? ref.id, shape: ref.shape, parent };
      nodes.push(node);
      byId.set(ref.id, node);
    }
    for (let k = 0; k < scanned.links.length; k++) {
      edges.push({
        source: scanned.refs[k].id,
        target: scanned.refs[k + 1].id,
        kind: scanned.links[k].kind,
        label: scanned.links[k].label,
      });
    }
  }

  if (!keyword) return fail('expected a flowchart or graph header', 1);
  if (open.length) return fail('unclosed subgraph', open[open.length - 1].line);
  return { ok: true, graph: canonical({ keyword, direction, nodes, edges, subgraphs, trailer }) };
}

function quoteLabel(label: string): string {
  return QUOTE_RE.test(label) ? `"${label.replace(/"/g, QUOT_ENTITY)}"` : label;
}

function nodeLine(n: FlowNode): string {
  if (n.label === n.id && n.shape === 'rect') return n.id;
  const shape = SHAPES.find((s) => s.shape === n.shape) ?? SHAPES[3];
  return `${n.id}${shape.open}${quoteLabel(n.label)}${shape.close}`;
}

function edgeLine(e: FlowEdge): string {
  const label = e.label === null ? '' : `|${e.label}|`;
  return `${e.source} ${ARROWS[e.kind]}${label} ${e.target}`;
}

export function serializeFlowchart(g: FlowGraph): string {
  const out = [`${g.keyword} ${g.direction}`];
  const emit = (s: FlowSubgraph, depth: number): void => {
    const pad = '  '.repeat(depth);
    out.push(`${pad}subgraph ${s.id} [${quoteLabel(s.title)}]`);
    for (const n of g.nodes) if (n.parent === s.id) out.push(`${pad}  ${nodeLine(n)}`);
    for (const child of g.subgraphs) if (child.parent === s.id) emit(child, depth + 1);
    out.push(`${pad}end`);
  };
  for (const s of g.subgraphs) if (s.parent === null) emit(s, 0);
  for (const n of g.nodes) if (n.parent === null) out.push(nodeLine(n));
  for (const e of g.edges) out.push(edgeLine(e));
  out.push(...g.trailer);
  return `${out.join('\n')}\n`;
}

const hasId = (g: FlowGraph, id: string): boolean =>
  g.nodes.some((n) => n.id === id) || g.subgraphs.some((s) => s.id === id);

const hasSubgraph = (g: FlowGraph, id: string): boolean => g.subgraphs.some((s) => s.id === id);

function descendsFrom(g: FlowGraph, id: string, ancestor: string): boolean {
  let at: string | null = id;
  const seen = new Set<string>();
  while (at !== null && !seen.has(at)) {
    if (at === ancestor) return true;
    seen.add(at);
    at = g.subgraphs.find((s) => s.id === at)?.parent ?? null;
  }
  return false;
}

export function addNode(
  g: FlowGraph,
  id: string,
  label: string,
  shape: FlowShape = 'rect',
  parent: string | null = null,
): FlowGraph {
  if (!FULL_ID_RE.test(id) || hasId(g, id)) return g;
  if (parent !== null && !hasSubgraph(g, parent)) return g;
  return canonical({ ...g, nodes: [...g.nodes, { id, label, shape, parent }] });
}

export function removeNode(g: FlowGraph, id: string): FlowGraph {
  if (!g.nodes.some((n) => n.id === id)) return g;
  return canonical({
    ...g,
    nodes: g.nodes.filter((n) => n.id !== id),
    edges: g.edges.filter((e) => e.source !== id && e.target !== id),
  });
}

export function renameNode(g: FlowGraph, id: string, label: string): FlowGraph {
  if (!g.nodes.some((n) => n.id === id)) return g;
  return canonical({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, label } : n)) });
}

export function addEdge(
  g: FlowGraph,
  source: string,
  target: string,
  kind: FlowEdgeKind = 'arrow',
): FlowGraph {
  if (!hasId(g, source) || !hasId(g, target)) return g;
  if (g.edges.some((e) => e.source === source && e.target === target)) return g;
  return canonical({ ...g, edges: [...g.edges, { source, target, kind, label: null }] });
}

export function removeEdge(g: FlowGraph, edgeIndex: number): FlowGraph {
  if (!g.edges[edgeIndex]) return g;
  return canonical({ ...g, edges: g.edges.filter((_, i) => i !== edgeIndex) });
}

export function relabelEdge(g: FlowGraph, edgeIndex: number, label: string | null): FlowGraph {
  if (!g.edges[edgeIndex]) return g;
  const next = label === null || !label.trim() ? null : label.trim();
  return canonical({
    ...g,
    edges: g.edges.map((e, i) => (i === edgeIndex ? { ...e, label: next } : e)),
  });
}

export function addSubgraph(
  g: FlowGraph,
  id: string,
  title: string,
  parent: string | null = null,
): FlowGraph {
  if (!FULL_ID_RE.test(id) || hasId(g, id)) return g;
  if (parent !== null && !hasSubgraph(g, parent)) return g;
  return canonical({ ...g, subgraphs: [...g.subgraphs, { id, title, parent }] });
}

export function moveToSubgraph(g: FlowGraph, nodeId: string, subgraphId: string | null): FlowGraph {
  if (subgraphId !== null && !hasSubgraph(g, subgraphId)) return g;
  const node = g.nodes.find((n) => n.id === nodeId);
  if (node) {
    if (node.parent === subgraphId) return g;
    return canonical({
      ...g,
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, parent: subgraphId } : n)),
    });
  }
  const subgraph = g.subgraphs.find((s) => s.id === nodeId);
  if (!subgraph || subgraph.parent === subgraphId) return g;
  if (subgraphId !== null && descendsFrom(g, subgraphId, nodeId)) return g;
  return canonical({
    ...g,
    subgraphs: g.subgraphs.map((s) => (s.id === nodeId ? { ...s, parent: subgraphId } : s)),
  });
}

export function nextNodeId(g: FlowGraph, base: string): string {
  let n = 1;
  while (hasId(g, `${base}${n}`)) n++;
  return `${base}${n}`;
}
