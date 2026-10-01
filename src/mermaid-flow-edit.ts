// Edit intents → a minimal text patch of the fence. Every rule here is spec §3.2
// (docs/specs/2026-09-30-interactive-plan-v2.md); the invariants are listed in the plan's item 1
// Contracts (docs/plans/2026-09-30-interactive-plan-v2.plan.md).

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

const LABEL_QUOTE_RE = /["[\]{}()|#<>]/;
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
const CLASS_RE = /^(class[ \t]+)(\S+)(.*)$/;
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

function linkText(kind: FlowEdgeKind, label: string | null): string {
  return label === null ? FLOW_ARROWS[kind] : `${FLOW_ARROWS[kind]}|${encodeLabel(label)}|`;
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
  restyled: boolean;
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
  edges: EdgeTag[];
  refs: string[];
  trailer: boolean;
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
  const patch = new Patch(parsed.doc);
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
  // Every rule above is meant to keep the fence parseable; a batch that still breaks it is one
  // the patcher can't express, and the batch is all-or-nothing.
  if (!result.ok) return { ok: false, refusal: 'unsupported', at: edits.length - 1 };
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

  constructor(private readonly doc: FlowDoc) {
    this.g = doc.graph;
    for (const n of this.g.nodes)
      this.nodes.set(n.id, {
        id: n.id,
        label: n.label,
        shape: n.shape,
        parent: n.parent,
        input: n,
        removed: false,
        restyled: false,
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
        n.restyled = true;
        this.changed = true;
        return;
      }
      case 'setShape': {
        const n = this.liveNode(edit.id);
        if (n.shape === edit.shape) return;
        n.shape = edit.shape;
        n.restyled = true;
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
      restyled: false,
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
    if (n.restyled || n.moved || n.input === null) refuse('conflict');
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
    for (const n of this.nodes.values()) if (n.parent === id) n.parent = s.parent;
    for (const c of this.subs.values()) if (c.parent === id) c.parent = s.parent;
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
      if (sub.moved || sub.input === null) refuse('unsupported');
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

  // ── emission ─────────────────────────────────────────────────────────────────────────────

  private replace = new Map<string, string>();
  /** Statements moved to the top level, by input line; their place holds `produced[line]`. */
  private readonly relocated = new Map<number, Line[]>();
  private readonly relocatedFrags: Line[] = [];
  private readonly blocks = new Map<string, Line[]>();

  private refText(n: NodeState): string {
    if (n.shape !== 'verbatim') return nodeText(n.id, n.label, n.shape);
    const def = n.input?.def;
    const ref = def ? readFlowRef(this.doc.lines[def.line].slice(def.start, def.end)) : null;
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
    const raw = this.doc.lines[stmt.line];
    return stmt.refs.map((s) => readFlowRef(raw.slice(s.start, s.end))?.id ?? '');
  }

  /** Whether a bare mention of `id` at `line` (in `scope`) leaves its membership alone. */
  private canMention(id: string, line: number, scope: string | null): boolean {
    const s = this.subs.get(id);
    if (s) return s.input !== null && !s.moved && s.input.open < line;
    const n = this.nodes.get(id);
    if (!n?.input || n.moved) return false;
    return n.input.first.line <= line || n.input.parent === scope;
  }

  /** `null` when the statement is untouched and keeps its bytes. */
  private chainLines(stmt: FlowStatement): Line[] | null {
    const raw = this.doc.lines[stmt.line];
    const ids = this.refIds(stmt);
    const links = stmt.links.map((_, k) => this.edgeIndex(stmt.line, k));
    const node = (id: string) => this.nodes.get(id);
    const touched =
      links.some((e) => {
        const st = this.edges[e];
        return st.removed || st.relinked || st.reconnected;
      }) ||
      stmt.refs.some((s) => this.replace.has(spanKey(s))) ||
      ids.some((id) => node(id)?.removed || node(id)?.moved || this.subs.get(id)?.removed);
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
      if (bare) return ids[k];
      const s = stmt.refs[k];
      return this.replace.get(spanKey(s)) ?? raw.slice(s.start, s.end);
    };
    const linkOut = (k: number): string => {
      const st = this.edges[links[k]];
      const s = stmt.links[k];
      return st.relinked ? linkText(st.kind, st.label) : raw.slice(s.start, s.end);
    };
    const line = (text: string, edges: EdgeTag[], refs: string[]): Line => ({
      indent: stmt.indent,
      text: whole ? `${text}${raw.slice(stmt.refs[stmt.refs.length - 1].end)}` : text,
      edges,
      refs,
      trailer: false,
    });

    const out: Line[] = [];
    for (const f of frags) {
      if ('reconnect' in f) {
        const st = this.edges[links[f.reconnect]];
        const l = line(
          `${st.source} ${linkOut(f.reconnect)} ${st.target}`,
          [links[f.reconnect]],
          [st.source, st.target],
        );
        const here =
          this.canMention(st.source, stmt.line, stmt.scope) &&
          this.canMention(st.target, stmt.line, stmt.scope);
        (here ? out : this.relocatedFrags).push(l);
        continue;
      }
      if (f.to === f.from) {
        // A lone node left behind by a split survives only if it is what declares that node.
        const n = node(ids[f.from])?.input;
        const key = spanKey(stmt.refs[f.from]);
        const declares =
          !!n && (stmt.links.length === 0 || spanKey(n.first) === key || spanKey(n.def) === key);
        const st = node(ids[f.from]);
        if (f.shared || !declares || !st || st.removed || st.moved) continue;
        out.push(line(refOut(f.from, false), [], [ids[f.from]]));
        continue;
      }
      let text = refOut(f.from, f.shared);
      for (let k = f.from; k < f.to; k++) {
        const gapA = raw.slice(stmt.refs[k].end, stmt.links[k].start);
        const gapB = raw.slice(stmt.links[k].end, stmt.refs[k + 1].start);
        text += `${gapA}${linkOut(k)}${gapB}${refOut(k + 1, false)}`;
      }
      out.push(line(text, links.slice(f.from, f.to), ids.slice(f.from, f.to + 1)));
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
        edges: [],
        refs: [],
        trailer: stmt.kind === 'trailer',
      };
      if (stmt.kind === 'chain') {
        const out = this.chainLines(stmt);
        produced.push(
          out ?? [
            {
              ...keep,
              edges: stmt.links.map((_, k) => this.edgeIndex(stmt.line, k)),
              refs: this.refIds(stmt),
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

  /**
   * Mermaid puts a node where it is first mentioned, so a move leaves no earlier mention of it in
   * another scope: each such statement moves to the top level, and every other node whose first or
   * defining mention it held is re-declared where it stood (spec §3.2, plan invariant B2).
   */
  private relocateForMoves(produced: Line[][]): void {
    for (const id of this.moves) {
      const target = this.nodes.get(id)?.parent ?? null;
      const landing = this.landing(target);
      for (let line = 0; line < landing; line++) {
        if (!produced[line].some((l) => l.refs.includes(id))) continue;
        if (this.doc.statements[line].scope === target) break;
        const stmt = this.doc.statements[line];
        const left: Line[] = [];
        for (const other of new Set(this.refIds(stmt))) {
          const n = this.nodes.get(other);
          if (!n?.input || other === id || n.removed || n.moved) continue;
          const defHere = n.input.def.line === line;
          if (!defHere && n.input.first.line !== line) continue;
          const def = n.input.def;
          const text = defHere
            ? (this.replace.get(spanKey(def)) ?? this.doc.lines[line].slice(def.start, def.end))
            : other;
          left.push({ indent: stmt.indent, text, edges: [], refs: [other], trailer: false });
        }
        this.relocated.set(line, produced[line]);
        produced[line] = left;
      }
    }
  }

  private cutSubgraphBlocks(produced: Line[][]): void {
    for (const id of this.subMoves) {
      const s = this.subs.get(id);
      if (!s?.input) continue;
      const { open, close } = s.input;
      const landing = this.landing(s.parent);
      // A node first mentioned inside the block and mentioned again between its old and new place
      // would change membership; refusing beats silently re-parenting it.
      for (const n of this.g.nodes) {
        if (n.first.line < open || n.first.line > close) continue;
        for (let line = close + 1; line < landing; line++)
          if (produced[line].some((l) => l.refs.includes(n.id))) refuse('unsupported');
      }
      const lines: Line[] = [];
      for (let line = open; line <= close; line++) {
        lines.push(...produced[line]);
        produced[line] = [];
      }
      this.blocks.set(id, lines);
      this.append(s.parent, { kind: 'block', id });
    }
  }

  emit(): string {
    for (const n of this.nodes.values())
      if (n.input && n.restyled && !n.removed)
        this.replace.set(spanKey(n.input.def), this.refText(n));
    const produced = this.produce();
    this.relocateForMoves(produced);
    this.cutSubgraphBlocks(produced);

    const out: Line[] = [];
    const flush = (at: number) => {
      for (const [scope, items] of this.appends) {
        if (scope !== null && this.subs.get(scope)?.input === null) continue;
        if (this.insertAt(scope) === at)
          out.push(...this.renderItems(items, this.siblingIndent(scope)));
      }
      if (this.insertAt(null) !== at) return;
      const top = this.siblingIndent(null);
      for (const line of [...this.relocated.keys()].sort((a, b) => a - b))
        for (const l of this.relocated.get(line) ?? []) out.push({ ...l, indent: top });
      for (const l of this.relocatedFrags) out.push({ ...l, indent: top });
      for (const e of this.newEdges)
        out.push({
          indent: top,
          text: `${e.source} ${linkText(e.kind, e.label)} ${e.target}`,
          edges: [null],
          refs: [e.source, e.target],
          trailer: false,
        });
    };
    for (let i = 0; i < this.doc.lines.length; i++) {
      flush(i);
      out.push(...produced[i]);
    }
    flush(this.doc.lines.length);

    return this.fixTrailer(out)
      .map((l) => `${l.indent}${l.text}`)
      .join(this.doc.eol);
  }

  private renderItems(items: readonly Item[], indent: string): Line[] {
    const out: Line[] = [];
    for (const it of items) {
      if (it.kind === 'decl') {
        const n = this.nodes.get(it.id);
        if (n && !n.removed)
          out.push({ indent, text: this.refText(n), edges: [], refs: [n.id], trailer: false });
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
      out.push({
        indent,
        text: subgraphHeader(s.id, s.title),
        edges: [],
        refs: [],
        trailer: false,
      });
      out.push(...this.renderItems(this.appends.get(s.id) ?? [], `${indent}${this.unit()}`));
      out.push({ indent, text: 'end', edges: [], refs: [], trailer: false });
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
        const ids = cls[2].split(',');
        const left = ids.filter((id) => !removed.has(id));
        if (left.length === 0) continue;
        kept.push(
          left.length === ids.length ? l : { ...l, text: `${cls[1]}${left.join(',')}${cls[3]}` },
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
