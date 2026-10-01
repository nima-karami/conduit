// Edit intents → a minimal text patch of the fence. Every rule here is spec §3.2
// (docs/specs/2026-09-30-interactive-plan-v2.md); the invariants are listed in the plan's item 1
// Contracts (docs/plans/2026-09-30-interactive-plan-v2.plan.md). Membership is mermaid's own
// listing rule — see `Membership` in mermaid-flow.ts.

import {
  FLOW_ARROWS,
  FLOW_SHAPE_TOKENS,
  type FlowDoc,
  type FlowEdgeKind,
  type FlowGraph,
  type FlowNode,
  type FlowShape,
  type FlowSpan,
  type FlowStatement,
  type FlowSubgraph,
  parseFlowchart,
  readFlowRef,
} from './mermaid-flow';

export type FlowEdit =
  | { op: 'addNode'; id: string; label: string; shape: FlowShape; parent: string | null }
  | { op: 'removeNode'; id: string }
  | { op: 'renameNode'; id: string; label: string }
  | { op: 'setShape'; id: string; shape: FlowShape }
  | { op: 'addEdge'; source: string; target: string; kind: FlowEdgeKind; label: string | null }
  | { op: 'removeEdge'; edge: number }
  | { op: 'relabelEdge'; edge: number; label: string | null }
  | { op: 'setEdgeKind'; edge: number; kind: FlowEdgeKind }
  | { op: 'reconnectEdge'; edge: number; source: string; target: string }
  | { op: 'addSubgraph'; id: string; title: string; parent: string | null }
  | { op: 'renameSubgraph'; id: string; title: string }
  /** Lifts its members to its parent. */
  | { op: 'removeSubgraph'; id: string }
  | { op: 'moveToSubgraph'; id: string; subgraph: string | null };

export type FlowEditRefusal =
  | 'unsupported'
  | 'duplicate-edge'
  | 'unknown-id'
  | 'invalid-id'
  | 'id-taken'
  | 'cycle'
  | 'conflict';

export type FlowEditResult =
  | { ok: true; source: string; doc: FlowDoc }
  | { ok: false; refusal: FlowEditRefusal; at: number };

// A leading `/` or `\` would read as a trapezoid/parallelogram opener (`a[/x/]`).
const LABEL_QUOTE_RE = /["[\]{}()|#<>]|^[/\\]/;
const FULL_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
// A statement starting with one of these words is read as that keyword, never as a node.
const RESERVED_IDS = new Set([
  'end',
  'subgraph',
  'flowchart',
  'graph',
  'classDef',
  'class',
  'style',
  'click',
  'linkStyle',
]);
const LINK_STYLE_RE = /^(linkStyle[ \t]+)(\d+(?:[ \t]*,[ \t]*\d+)*)(.*)$/;
const NODE_TRAILER_RE = /^(style|click)[ \t]+([A-Za-z0-9_][A-Za-z0-9_-]*)/;
const CLASS_RE = /^(class[ \t]+)([^ \t,]+(?:[ \t]*,[ \t]*[^ \t,]+)*)([ \t]+\S.*)$/;
const TEXT_LINK_RE = /^--[ \t]/;
const DEFAULT_UNIT = '  ';

export function encodeLabel(label: string): string {
  if (!LABEL_QUOTE_RE.test(label)) return label;
  return `"${label.replace(/#/g, '#35;').replace(/"/g, '#quot;')}"`;
}

const hasId = (g: FlowGraph, id: string): boolean =>
  g.nodes.some((n) => n.id === id) || g.subgraphs.some((s) => s.id === id);

export function nextNodeId(g: FlowGraph, base: string): string {
  let n = 1;
  while (hasId(g, `${base}${n}`)) n++;
  return `${base}${n}`;
}

function nodeText(id: string, label: string, shape: FlowShape): string {
  if (shape === 'rect' && label === id) return id;
  const t = FLOW_SHAPE_TOKENS[shape];
  return `${id}${t.open}${encodeLabel(label)}${t.close}`;
}

/** `was` is the link as written; a `-- x -->` spelling survives a plain relabel. */
function linkText(
  kind: FlowEdgeKind,
  label: string | null,
  was?: { text: string; kind: FlowEdgeKind },
) {
  if (label === null) return FLOW_ARROWS[kind];
  const plain = encodeLabel(label) === label && !label.includes('-');
  if (was && was.kind === kind && plain && TEXT_LINK_RE.test(was.text))
    return `-- ${label} ${FLOW_ARROWS[kind]}`;
  return `${FLOW_ARROWS[kind]}|${encodeLabel(label)}|`;
}

const subgraphHeader = (id: string, title: string): string =>
  `subgraph ${id} [${encodeLabel(title)}]`;

const spanKey = (s: FlowSpan): string => `${s.line}:${s.start}`;

interface NodeState {
  id: string;
  label: string;
  shape: FlowShape | 'verbatim';
  parent: string | null;
  input: FlowNode | null;
  removed: boolean;
  renamed: boolean;
  reshaped: boolean;
  moved: boolean;
}

interface SubState {
  id: string;
  title: string;
  parent: string | null;
  input: FlowSubgraph | null;
  removed: boolean;
  renamed: boolean;
  moved: boolean;
}

interface EdgeState {
  source: string;
  target: string;
  kind: FlowEdgeKind;
  label: string | null;
  removed: boolean;
  relinked: boolean;
  reconnected: boolean;
}

/** `null` = an edge added by this batch. */
type EdgeTag = number | null;

interface Line {
  indent: string;
  text: string;
  /** The line break written after this line. */
  eol: string;
  /** The subgraph whose body this line ends up in. */
  scope: string | null;
  edges: EdgeTag[];
  refs: string[];
  /** Ids this line mentions WITH a label. */
  labelled: string[];
  trailer: boolean;
  /** A lone node left behind by a split or a relocation; kept only if something needs it. */
  lone?: boolean;
  /** A declaration whose label is decided once every other line is known. */
  decl?: string;
}

type Item = { kind: 'decl'; id: string } | { kind: 'block'; id: string };

class Refused {
  constructor(readonly refusal: FlowEditRefusal) {}
}

function refuse(refusal: FlowEditRefusal): never {
  throw new Refused(refusal);
}

export function applyFlowEdits(source: string, edits: readonly FlowEdit[]): FlowEditResult {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) return { ok: false, refusal: 'unsupported', at: 0 };
  const patch = new Patch(parsed.doc, source.match(/\r?\n/g) ?? []);
  for (let at = 0; at < edits.length; at++) {
    try {
      patch.apply(edits[at]);
    } catch (e) {
      if (e instanceof Refused) return { ok: false, refusal: e.refusal, at };
      throw e;
    }
  }
  if (!patch.changed) return { ok: true, source, doc: parsed.doc };
  let text: string;
  try {
    text = patch.emit();
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal, at: edits.length - 1 };
    throw e;
  }
  const result = parseFlowchart(text);
  // The root guard: whatever the rules above produced, the batch only lands if mermaid would read
  // exactly the intended graph back — no untargeted node relabelled, reshaped or re-parented.
  if (!result.ok || !patch.matches(result.doc.graph))
    return { ok: false, refusal: 'unsupported', at: edits.length - 1 };
  return { ok: true, source: text, doc: result.doc };
}

class Patch {
  changed = false;
  private readonly g: FlowGraph;
  private readonly nodes = new Map<string, NodeState>();
  private readonly subs = new Map<string, SubState>();
  private readonly edges: EdgeState[];
  private readonly newEdges: EdgeState[] = [];
  private readonly appends = new Map<string | null, Item[]>();
  private readonly moves: string[] = [];
  private readonly subMoves: string[] = [];
  /** Every mention carrying a label, per node — a rename rewrites them all (mermaid keeps the last). */
  private readonly labelledSpans = new Map<string, FlowSpan[]>();
  /** The ids each subgraph's own body lists — the input to mermaid's membership rule. */
  private readonly listed = new Map<string, Set<string>>();
  /** Reconnected links that would give an endpoint a new listing; they go to the top level. */
  private readonly lifted: Line[] = [];

  constructor(
    private readonly doc: FlowDoc,
    private readonly seps: readonly string[],
  ) {
    this.g = doc.graph;
    for (const n of this.g.nodes)
      this.nodes.set(n.id, {
        id: n.id,
        label: n.label,
        shape: n.shape,
        parent: n.parent,
        input: n,
        removed: false,
        renamed: false,
        reshaped: false,
        moved: false,
      });
    for (const s of this.g.subgraphs)
      this.subs.set(s.id, {
        id: s.id,
        title: s.title,
        parent: s.parent,
        input: s,
        removed: false,
        renamed: false,
        moved: false,
      });
    this.edges = this.g.edges.map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      label: e.label,
      removed: false,
      relinked: false,
      reconnected: false,
    }));
    for (const stmt of doc.statements) {
      if (stmt.kind === 'subgraph' && stmt.scope !== null) {
        const sub = this.g.subgraphs.find((x) => x.open === stmt.line);
        if (sub) this.list(stmt.scope, sub.id);
      }
      if (stmt.kind !== 'chain') continue;
      if (stmt.scope !== null) for (const id of this.refIds(stmt)) this.list(stmt.scope, id);
      for (const span of stmt.refs) {
        const ref = readFlowRef(this.spanText(span));
        if (!ref || ref.label === null) continue;
        const list = this.labelledSpans.get(ref.id);
        if (list) list.push(span);
        else this.labelledSpans.set(ref.id, [span]);
      }
    }
  }

  private list(scope: string, id: string): void {
    const ids = this.listed.get(scope);
    if (ids) ids.add(id);
    else this.listed.set(scope, new Set([id]));
  }

  /** Mermaid's owner of `id`: the earliest-closed live subgraph whose body lists it. */
  private ownerOf(id: string): string | null {
    let owner: SubState | null = null;
    for (const s of this.subs.values()) {
      if (s.removed || !s.input || !this.listed.get(s.id)?.has(id)) continue;
      if (!owner?.input || s.input.close < owner.input.close) owner = s;
    }
    return owner?.id ?? null;
  }

  private spanText(s: FlowSpan): string {
    return this.doc.lines[s.line].slice(s.start, s.end);
  }

  // ── intents ──────────────────────────────────────────────────────────────────────────────

  apply(edit: FlowEdit): void {
    switch (edit.op) {
      case 'addNode':
        this.addNode(edit.id, edit.label, edit.shape, edit.parent);
        return;
      case 'removeNode':
        this.removeNode(edit.id);
        return;
      case 'renameNode': {
        const n = this.liveNode(edit.id);
        if (n.label === edit.label) return;
        n.label = edit.label;
        n.renamed = true;
        this.changed = true;
        return;
      }
      case 'setShape': {
        const n = this.liveNode(edit.id);
        if (n.shape === edit.shape) return;
        n.shape = edit.shape;
        n.reshaped = true;
        this.changed = true;
        return;
      }
      case 'addEdge':
        this.addEdge(edit.source, edit.target, edit.kind, edit.label);
        return;
      case 'removeEdge': {
        const e = this.edgeAt(edit.edge);
        if (e.relinked || e.reconnected) refuse('conflict');
        e.removed = true;
        this.changed = true;
        return;
      }
      case 'relabelEdge': {
        const e = this.liveEdge(edit.edge);
        const label = edit.label === null || !edit.label.trim() ? null : edit.label.trim();
        if (e.label === label) return;
        if (e.relinked && e.label !== this.g.edges[edit.edge].label) refuse('conflict');
        e.label = label;
        e.relinked = true;
        this.changed = true;
        return;
      }
      case 'setEdgeKind': {
        const e = this.liveEdge(edit.edge);
        if (e.kind === edit.kind) return;
        if (e.relinked && e.kind !== this.g.edges[edit.edge].kind) refuse('conflict');
        e.kind = edit.kind;
        e.relinked = true;
        this.changed = true;
        return;
      }
      case 'reconnectEdge': {
        const e = this.liveEdge(edit.edge);
        if (e.source === edit.source && e.target === edit.target) return;
        if (e.reconnected) refuse('conflict');
        this.liveEndpoint(edit.source);
        this.liveEndpoint(edit.target);
        if (this.duplicates(edit.source, edit.target, e.kind, e.label)) refuse('duplicate-edge');
        e.source = edit.source;
        e.target = edit.target;
        e.reconnected = true;
        this.changed = true;
        return;
      }
      case 'addSubgraph':
        this.addSubgraph(edit.id, edit.title, edit.parent);
        return;
      case 'renameSubgraph': {
        const s = this.liveSub(edit.id);
        if (s.title === edit.title) return;
        s.title = edit.title;
        s.renamed = true;
        this.changed = true;
        return;
      }
      case 'removeSubgraph':
        this.removeSubgraph(edit.id);
        return;
      case 'moveToSubgraph':
        this.moveToSubgraph(edit.id, edit.subgraph);
        return;
    }
  }

  private liveNode(id: string): NodeState {
    const n = this.nodes.get(id);
    if (!n) return refuse('unknown-id');
    if (n.removed) refuse('conflict');
    return n;
  }

  private liveSub(id: string): SubState {
    const s = this.subs.get(id);
    if (!s) return refuse('unknown-id');
    if (s.removed) refuse('conflict');
    return s;
  }

  private liveEndpoint(id: string): void {
    if (this.subs.has(id)) this.liveSub(id);
    else this.liveNode(id);
  }

  /** A moved subgraph's block is cut and re-emitted whole, so nothing new may land in it. */
  private liveScope(id: string | null): void {
    if (id !== null && this.liveSub(id).moved) refuse('conflict');
  }

  private edgeAt(index: number): EdgeState {
    const e = Number.isInteger(index) ? this.edges[index] : undefined;
    if (!e) return refuse('unknown-id');
    return e;
  }

  private liveEdge(index: number): EdgeState {
    const e = this.edgeAt(index);
    if (e.removed) refuse('conflict');
    return e;
  }

  private duplicates(source: string, target: string, kind: FlowEdgeKind, label: string | null) {
    return [...this.edges, ...this.newEdges].some(
      (e) =>
        !e.removed &&
        e.source === source &&
        e.target === target &&
        e.kind === kind &&
        e.label === label,
    );
  }

  private checkNewId(id: string): void {
    if (!FULL_ID_RE.test(id) || RESERVED_IDS.has(id)) refuse('invalid-id');
    if (this.nodes.has(id) || this.subs.has(id)) refuse('id-taken');
  }

  private append(scope: string | null, item: Item): void {
    const list = this.appends.get(scope);
    if (list) list.push(item);
    else this.appends.set(scope, [item]);
  }

  private addNode(id: string, label: string, shape: FlowShape, parent: string | null): void {
    this.checkNewId(id);
    this.liveScope(parent);
    this.nodes.set(id, {
      id,
      label,
      shape,
      parent,
      input: null,
      removed: false,
      renamed: false,
      reshaped: false,
      moved: false,
    });
    this.append(parent, { kind: 'decl', id });
    this.changed = true;
  }

  private addSubgraph(id: string, title: string, parent: string | null): void {
    this.checkNewId(id);
    this.liveScope(parent);
    this.subs.set(id, {
      id,
      title,
      parent,
      input: null,
      removed: false,
      renamed: false,
      moved: false,
    });
    this.append(parent, { kind: 'block', id });
    this.changed = true;
  }

  private addEdge(source: string, target: string, kind: FlowEdgeKind, label: string | null) {
    this.liveEndpoint(source);
    this.liveEndpoint(target);
    if (this.duplicates(source, target, kind, label)) refuse('duplicate-edge');
    this.newEdges.push({
      source,
      target,
      kind,
      label,
      removed: false,
      relinked: false,
      reconnected: false,
    });
    this.changed = true;
  }

  /** Every edge touching `id`, which a removal takes with it. */
  private dropIncident(id: string): void {
    for (const e of this.edges) {
      if (e.removed || (e.source !== id && e.target !== id)) continue;
      if (e.relinked || e.reconnected) refuse('conflict');
      e.removed = true;
    }
    if (this.newEdges.some((e) => e.source === id || e.target === id)) refuse('conflict');
  }

  private removeNode(id: string): void {
    const n = this.nodes.get(id);
    if (!n) refuse('unknown-id');
    if (n.removed) return;
    if (n.renamed || n.reshaped || n.moved || n.input === null) refuse('conflict');
    this.dropIncident(id);
    n.removed = true;
    this.changed = true;
  }

  private removeSubgraph(id: string): void {
    const s = this.subs.get(id);
    if (!s) refuse('unknown-id');
    if (s.removed) return;
    if (s.renamed || s.moved || s.input === null || this.appends.get(id)?.length)
      refuse('conflict');
    this.dropIncident(id);
    s.removed = true;
    // Its body lines stay, now in the scope its header was written in; who owns its members is
    // mermaid's rule again, not simply its parent (a sibling listing a member can claim it).
    const lexical = this.doc.statements[s.input.open].scope;
    if (lexical !== null) for (const x of this.listed.get(id) ?? []) this.list(lexical, x);
    this.listed.delete(id);
    for (const n of this.nodes.values()) if (n.parent === id) n.parent = this.ownerOf(n.id);
    for (const c of this.subs.values()) if (c.parent === id) c.parent = this.ownerOf(c.id);
    this.changed = true;
  }

  private descends(id: string, ancestor: string): boolean {
    const seen = new Set<string>();
    for (
      let at: string | null = id;
      at !== null && !seen.has(at);
      at = this.subs.get(at)?.parent ?? null
    ) {
      if (at === ancestor) return true;
      seen.add(at);
    }
    return false;
  }

  private moveToSubgraph(id: string, target: string | null): void {
    this.liveScope(target);
    const sub = this.subs.get(id);
    if (sub) {
      this.liveSub(id);
      if (target !== null && this.descends(target, id)) refuse('cycle');
      if (sub.parent === target) return;
      if (sub.moved || sub.input === null || this.appends.get(id)?.length) refuse('conflict');
      sub.parent = target;
      sub.moved = true;
      this.subMoves.push(id);
      this.changed = true;
      return;
    }
    const n = this.liveNode(id);
    if (n.parent === target) return;
    n.parent = target;
    this.changed = true;
    for (const list of this.appends.values()) {
      const i = list.findIndex((it) => it.kind === 'decl' && it.id === id);
      if (i >= 0) list.splice(i, 1);
    }
    this.append(target, { kind: 'decl', id });
    if (n.input === null || n.moved) return;
    n.moved = true;
    this.moves.push(id);
  }

  // ── the root guard ───────────────────────────────────────────────────────────────────────

  matches(out: FlowGraph): boolean {
    const nodes = new Map(out.nodes.map((n) => [n.id, n]));
    const subs = new Map(out.subgraphs.map((s) => [s.id, s]));
    const liveNodes = [...this.nodes.values()].filter((n) => !n.removed);
    const liveSubs = [...this.subs.values()].filter((s) => !s.removed);
    if (nodes.size !== liveNodes.length || subs.size !== liveSubs.length) return false;
    for (const n of liveNodes) {
      const o = nodes.get(n.id);
      if (!o || o.label !== n.label || o.shape !== n.shape || o.parent !== n.parent) return false;
    }
    for (const s of liveSubs) {
      const o = subs.get(s.id);
      if (!o || o.title !== s.title || o.parent !== s.parent) return false;
    }
    const key = (e: { source: string; target: string; kind: string; label: string | null }) =>
      `${e.source}\0${e.target}\0${e.kind}\0${e.label ?? '\0'}`;
    const want = [...this.edges, ...this.newEdges]
      .filter((e) => !e.removed)
      .map(key)
      .sort();
    const got = out.edges.map(key).sort();
    return want.length === got.length && want.every((k, i) => k === got[i]);
  }

  // ── emission ─────────────────────────────────────────────────────────────────────────────

  private readonly replace = new Map<string, string>();
  /** Statements moved to the top level, by input line; their place holds `produced[line]`. */
  private readonly relocated = new Map<number, Line[]>();
  private readonly blocks = new Map<string, Line[]>();

  private eolOf(line: number): string {
    return this.seps[line] ?? this.doc.eol;
  }

  /** The text a renamed/reshaped node's mention at `span` becomes. */
  private mentionText(n: NodeState, span: FlowSpan): string {
    const ref = readFlowRef(this.spanText(span));
    if (!n.reshaped && ref && ref.label !== null)
      return `${n.id}${ref.open}${encodeLabel(n.label)}${ref.close}`;
    return n.shape === 'verbatim' ? this.refText(n) : nodeText(n.id, n.label, n.shape);
  }

  private refText(n: NodeState): string {
    if (n.shape !== 'verbatim') return nodeText(n.id, n.label, n.shape);
    const spans = this.labelledSpans.get(n.id) ?? [];
    const ref = spans.length ? readFlowRef(this.spanText(spans[spans.length - 1])) : null;
    if (!ref) return refuse('unsupported');
    return `${n.id}${ref.open}${encodeLabel(n.label)}${ref.close}`;
  }

  /** The input line new statements for `scope` are inserted before. */
  private insertAt(scope: string | null): number {
    const base =
      scope === null
        ? (this.doc.statements.find((s) => s.kind === 'header')?.line ?? 0)
        : (this.subs.get(scope)?.input?.open ?? 0);
    let at = base;
    for (const s of this.doc.statements)
      if (s.scope === scope && (s.kind === 'chain' || s.kind === 'subgraph' || s.kind === 'end'))
        at = Math.max(at, s.line);
    return at + 1;
  }

  /** Where a (possibly new, possibly nested-new) scope's content lands, as an input line. */
  private landing(scope: string | null): number {
    let at = scope;
    while (at !== null && this.subs.get(at)?.input === null) at = this.subs.get(at)?.parent ?? null;
    return this.insertAt(at);
  }

  private unit(): string {
    const top = this.doc.statements.find(
      (s) => s.scope === null && (s.kind === 'chain' || s.kind === 'subgraph'),
    );
    return top?.indent || DEFAULT_UNIT;
  }

  private siblingIndent(scope: string | null): string {
    let indent: string | null = null;
    for (const s of this.doc.statements)
      if (s.scope === scope && (s.kind === 'chain' || s.kind === 'subgraph')) indent = s.indent;
    if (indent !== null) return indent;
    const open =
      scope === null
        ? this.doc.statements.find((s) => s.kind === 'header')?.line
        : this.subs.get(scope)?.input?.open;
    return `${open === undefined ? '' : this.doc.statements[open].indent}${this.unit()}`;
  }

  private edgeIndex(stmt: number, link: number): number {
    return this.g.edges.findIndex((e) => e.stmt === stmt && e.link === link);
  }

  private refIds(stmt: FlowStatement): string[] {
    return stmt.refs.map((s) => readFlowRef(this.spanText(s))?.id ?? '');
  }

  private isLabelled(span: FlowSpan): boolean {
    return (readFlowRef(this.spanText(span))?.label ?? null) !== null;
  }

  /**
   * The statement's lines. `relocate` re-emits it for the top level: every mention bare (the label
   * stays with what is left behind) and no lone nodes. Otherwise `null` = untouched, keep the bytes.
   */
  private chainLines(stmt: FlowStatement, relocate: boolean): Line[] | null {
    const raw = this.doc.lines[stmt.line];
    const ids = this.refIds(stmt);
    const links = stmt.links.map((_, k) => this.edgeIndex(stmt.line, k));
    const node = (id: string) => this.nodes.get(id);
    const scope = relocate ? null : stmt.scope;
    if (stmt.links.length === 0) {
      const n = node(ids[0]);
      if (n?.removed || n?.moved) return [];
    }
    const touched =
      relocate ||
      links.some((e) => {
        const st = this.edges[e];
        return st.removed || st.relinked || st.reconnected;
      }) ||
      stmt.refs.some((s) => this.replace.has(spanKey(s))) ||
      ids.some((id) => node(id)?.removed || this.subs.get(id)?.removed);
    if (!touched) return null;

    // An edit to one link of a chain splits the chain at that link (spec §3.2); a fragment that
    // starts on the node the previous one ended on (`shared`) repeats it as a bare id.
    type Frag = { from: number; to: number; shared: boolean } | { reconnect: number };
    const frags: Frag[] = [];
    let cur = { from: 0, to: 0, shared: false };
    links.forEach((e, k) => {
      const st = this.edges[e];
      if (st.removed || st.reconnected) {
        frags.push(cur);
        if (st.reconnected) frags.push({ reconnect: k });
        cur = { from: k + 1, to: k + 1, shared: false };
      } else if (st.relinked) {
        if (cur.to > cur.from) {
          frags.push(cur);
          cur = { from: k, to: k, shared: true };
        }
        cur.to = k + 1;
        frags.push(cur);
        cur = { from: k + 1, to: k + 1, shared: true };
      } else cur.to = k + 1;
    });
    frags.push(cur);

    const whole = frags.length === 1;
    const refOut = (k: number, bare: boolean): string => {
      if (bare || relocate) return ids[k];
      const s = stmt.refs[k];
      return this.replace.get(spanKey(s)) ?? raw.slice(s.start, s.end);
    };
    const labelledAt = (k: number) => !relocate && this.isLabelled(stmt.refs[k]);
    const linkOut = (k: number): string => {
      const st = this.edges[links[k]];
      const s = stmt.links[k];
      const text = raw.slice(s.start, s.end);
      return st.relinked
        ? linkText(st.kind, st.label, { text, kind: this.g.edges[links[k]].kind })
        : text;
    };
    const line = (
      text: string,
      edges: EdgeTag[],
      refs: string[],
      labelled: string[],
      lone = false,
    ): Line => ({
      indent: stmt.indent,
      text: whole && !relocate ? `${text}${raw.slice(stmt.refs[stmt.refs.length - 1].end)}` : text,
      eol: this.eolOf(stmt.line),
      scope,
      edges,
      refs,
      labelled,
      trailer: false,
      lone,
    });

    const out: Line[] = [];
    for (const f of frags) {
      if ('reconnect' in f) {
        const st = this.edges[links[f.reconnect]];
        const l = line(
          `${st.source} ${linkOut(f.reconnect)} ${st.target}`,
          [links[f.reconnect]],
          [st.source, st.target],
          [],
        );
        // Written in a subgraph, a new endpoint would be listed there and could change owner;
        // at the top level a mention confers nothing.
        const listing = scope === null ? null : this.listed.get(scope);
        if (listing !== null && ![st.source, st.target].every((id) => listing?.has(id)))
          this.lifted.push({ ...l, scope: null });
        else out.push(l);
        continue;
      }
      if (f.to === f.from) {
        const id = ids[f.from];
        const n = node(id);
        if (relocate || f.shared || !n || n.removed || n.moved) continue;
        const lone = stmt.links.length > 0;
        out.push(line(refOut(f.from, false), [], [id], labelledAt(f.from) ? [id] : [], lone));
        continue;
      }
      let text = refOut(f.from, f.shared);
      const labelled = f.shared ? [] : labelledAt(f.from) ? [ids[f.from]] : [];
      for (let k = f.from; k < f.to; k++) {
        const gapA = raw.slice(stmt.refs[k].end, stmt.links[k].start);
        const gapB = raw.slice(stmt.links[k].end, stmt.refs[k + 1].start);
        text += `${gapA}${linkOut(k)}${gapB}${refOut(k + 1, false)}`;
        if (labelledAt(k + 1)) labelled.push(ids[k + 1]);
      }
      out.push(line(text, links.slice(f.from, f.to), ids.slice(f.from, f.to + 1), labelled));
    }
    return out;
  }

  private produce(): Line[][] {
    const produced: Line[][] = [];
    for (const stmt of this.doc.statements) {
      const raw = this.doc.lines[stmt.line];
      const keep: Line = {
        indent: stmt.indent,
        text: raw.slice(stmt.indent.length),
        eol: this.eolOf(stmt.line),
        scope: stmt.scope,
        edges: [],
        refs: [],
        labelled: [],
        trailer: stmt.kind === 'trailer',
      };
      if (stmt.kind === 'chain') {
        const ids = this.refIds(stmt);
        produced.push(
          this.chainLines(stmt, false) ?? [
            {
              ...keep,
              edges: stmt.links.map((_, k) => this.edgeIndex(stmt.line, k)),
              refs: ids,
              labelled: ids.filter((_, k) => this.isLabelled(stmt.refs[k])),
            },
          ],
        );
        continue;
      }
      const sub = this.g.subgraphs.find(
        (s) =>
          (stmt.kind === 'subgraph' && s.open === stmt.line) ||
          (stmt.kind === 'end' && s.close === stmt.line),
      );
      const state = sub ? this.subs.get(sub.id) : undefined;
      if (state?.removed) produced.push([]);
      else if (state?.renamed && stmt.kind === 'subgraph')
        produced.push([{ ...keep, text: subgraphHeader(state.id, state.title) }]);
      else produced.push([keep]);
    }
    return produced;
  }

  /** Whether subgraph `s` registers before `target` would — mermaid's earliest-closed rule. */
  private closesBefore(s: string, target: string | null): boolean {
    const close = this.subs.get(s)?.input?.close ?? Number.POSITIVE_INFINITY;
    if (target === null) return true;
    const t = this.subs.get(target)?.input;
    return close < (t ? t.close : this.landing(target));
  }

  /**
   * A node belongs to the earliest-closed subgraph whose body mentions it, so a move takes every
   * statement that would out-rank the target to the top level, where mentions confer nothing. What
   * those statements also said about other nodes is left behind as lone declarations (B2).
   */
  private relocateForMoves(produced: Line[][]): void {
    for (const id of this.moves) {
      const target = this.nodes.get(id)?.parent ?? null;
      for (const stmt of this.doc.statements) {
        if (stmt.kind !== 'chain' || stmt.scope === null || stmt.scope === target) continue;
        if (this.relocated.has(stmt.line) || !this.closesBefore(stmt.scope, target)) continue;
        if (!produced[stmt.line].some((l) => l.refs.includes(id))) continue;
        const left: Line[] = [];
        const ids = this.refIds(stmt);
        for (const other of new Set(ids)) {
          const n = this.nodes.get(other);
          if (!n?.input || n.removed || n.moved) continue;
          const k = ids.lastIndexOf(other);
          let labelledK = -1;
          ids.forEach((x, i) => {
            if (x === other && this.isLabelled(stmt.refs[i])) labelledK = i;
          });
          const span = stmt.refs[labelledK >= 0 ? labelledK : k];
          left.push({
            indent: stmt.indent,
            text: labelledK >= 0 ? (this.replace.get(spanKey(span)) ?? this.spanText(span)) : other,
            eol: this.eolOf(stmt.line),
            scope: stmt.scope,
            edges: [],
            refs: [other],
            labelled: labelledK >= 0 ? [other] : [],
            trailer: false,
            lone: true,
          });
        }
        this.relocated.set(stmt.line, this.chainLines(stmt, true) ?? []);
        produced[stmt.line] = left;
      }
    }
  }

  private cutSubgraphBlocks(produced: Line[][]): void {
    for (const id of this.subMoves) {
      const s = this.subs.get(id);
      if (!s?.input) continue;
      const lines: Line[] = [];
      for (let line = s.input.open; line <= s.input.close; line++) {
        lines.push(...produced[line]);
        produced[line] = [];
      }
      this.blocks.set(id, lines);
      this.append(s.parent, { kind: 'block', id });
    }
  }

  emit(): string {
    for (const n of this.nodes.values()) {
      if (!n.input || n.removed || (!n.renamed && !n.reshaped)) continue;
      const spans = this.labelledSpans.get(n.id) ?? [n.input.def];
      for (const span of spans) this.replace.set(spanKey(span), this.mentionText(n, span));
    }
    const produced = this.produce();
    this.relocateForMoves(produced);
    this.cutSubgraphBlocks(produced);

    const out: Line[] = [];
    const flush = (at: number) => {
      for (const [scope, items] of this.appends) {
        if (scope !== null && this.subs.get(scope)?.input === null) continue;
        if (this.insertAt(scope) === at)
          out.push(...this.renderItems(items, this.siblingIndent(scope), scope));
      }
      if (this.insertAt(null) !== at) return;
      const top = this.siblingIndent(null);
      const bare = (text: string, edges: EdgeTag[], refs: string[]): Line => ({
        indent: top,
        text,
        eol: this.doc.eol,
        scope: null,
        edges,
        refs,
        labelled: [],
        trailer: false,
      });
      for (const line of [...this.relocated.keys()].sort((a, b) => a - b))
        for (const l of this.relocated.get(line) ?? []) out.push({ ...l, indent: top });
      for (const l of this.lifted) out.push({ ...l, indent: top });
      for (const e of this.newEdges)
        out.push(
          bare(
            `${e.source} ${linkText(e.kind, e.label)} ${e.target}`,
            [null],
            [e.source, e.target],
          ),
        );
    };
    for (let i = 0; i < this.doc.lines.length; i++) {
      flush(i);
      out.push(...produced[i]);
    }
    flush(this.doc.lines.length);

    const lines = this.fixTrailer(this.settleDecls(this.settleLone(out)));
    // The input's last line carries no break; one written after it needs the fence's own.
    return lines
      .map((l, i) =>
        i < lines.length - 1 ? `${l.indent}${l.text}${l.eol}` : `${l.indent}${l.text}`,
      )
      .join('');
  }

  /**
   * A lone node stays only if it is needed: it carries a label, or nothing else in its subgraph's
   * body lists it any more (membership), or nothing else mentions it at all (existence).
   */
  private settleLone(out: Line[]): Line[] {
    const inScope = new Map<string | null, Set<string>>();
    const anywhere = new Set<string>();
    const note = (l: Line) => {
      for (const id of l.refs) {
        anywhere.add(id);
        const set = inScope.get(l.scope);
        if (set) set.add(id);
        else inScope.set(l.scope, new Set([id]));
      }
    };
    for (const l of out) if (!l.lone) note(l);
    const kept: Line[] = [];
    for (const l of out) {
      if (l.lone) {
        const id = l.refs[0];
        const needed =
          l.labelled.length > 0 ||
          (l.scope !== null && !inScope.get(l.scope)?.has(id)) ||
          !anywhere.has(id);
        if (!needed) continue;
        note(l);
      }
      kept.push(l);
    }
    return kept;
  }

  /** A declaration carries the label only when no other mention still does (Q1: one label). */
  private settleDecls(out: Line[]): Line[] {
    return out.map((l) => {
      if (l.decl === undefined) return l;
      const n = this.nodes.get(l.decl);
      if (!n) return l;
      const elsewhere = out.some((o) => o !== l && o.labelled.includes(n.id));
      return elsewhere ? l : { ...l, text: this.refText(n), labelled: [n.id] };
    });
  }

  private renderItems(items: readonly Item[], indent: string, scope: string | null): Line[] {
    const out: Line[] = [];
    const plain = (text: string, s: string | null): Line => ({
      indent,
      text,
      eol: this.doc.eol,
      scope: s,
      edges: [],
      refs: [],
      labelled: [],
      trailer: false,
    });
    for (const it of items) {
      if (it.kind === 'decl') {
        const n = this.nodes.get(it.id);
        if (n && !n.removed) out.push({ ...plain(n.id, scope), refs: [n.id], decl: n.id });
        continue;
      }
      const moved = this.blocks.get(it.id);
      if (moved) {
        const from = moved[0]?.indent ?? '';
        for (const l of moved)
          out.push({
            ...l,
            indent: l.indent.startsWith(from)
              ? `${indent}${l.indent.slice(from.length)}`
              : l.indent,
          });
        continue;
      }
      const s = this.subs.get(it.id);
      if (!s) continue;
      out.push(plain(subgraphHeader(s.id, s.title), scope));
      out.push(...this.renderItems(this.appends.get(s.id) ?? [], `${indent}${this.unit()}`, s.id));
      out.push(plain('end', scope));
    }
    return out;
  }

  /** `style`/`click`/`class` upkeep for removed ids, and `linkStyle` renumbering (spec §3.2). */
  private fixTrailer(out: Line[]): Line[] {
    const removed = new Set<string>();
    for (const n of this.nodes.values()) if (n.removed) removed.add(n.id);
    for (const s of this.subs.values()) if (s.removed) removed.add(s.id);

    const renumber = new Map<number, number>();
    out
      .flatMap((l) => l.edges)
      .forEach((tag, i) => {
        if (tag !== null) renumber.set(tag, i);
      });
    const reordered =
      renumber.size !== this.g.edges.length || [...renumber].some(([from, to]) => from !== to);

    const kept: Line[] = [];
    for (const l of out) {
      if (!l.trailer) {
        kept.push(l);
        continue;
      }
      const node = NODE_TRAILER_RE.exec(l.text);
      if (node && removed.has(node[2])) continue;
      const cls = CLASS_RE.exec(l.text);
      if (cls) {
        const ids = cls[2].split(/[ \t]*,[ \t]*/);
        const left = ids.filter((id) => !removed.has(id));
        if (left.length === 0) continue;
        const sep = /[ \t]*,[ \t]*/.exec(cls[2])?.[0] ?? ',';
        kept.push(
          left.length === ids.length ? l : { ...l, text: `${cls[1]}${left.join(sep)}${cls[3]}` },
        );
        continue;
      }
      const style = LINK_STYLE_RE.exec(l.text);
      if (style && reordered) {
        const next = style[2].split(',').flatMap((x) => {
          const i = Number(x.trim());
          if (i >= this.g.edges.length) return [i];
          const to = renumber.get(i);
          return to === undefined ? [] : [to];
        });
        if (next.length > 0) kept.push({ ...l, text: `${style[1]}${next.join(',')}${style[3]}` });
        continue;
      }
      kept.push(l);
    }
    return kept;
  }
}
