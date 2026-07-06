// Architecture diagram model. Pure + unit-tested; persisted as architecture.json
// in a project's root so the app and an agent working in that project read/write
// the same file. A document is a TREE OF GRAPHS — each node may own a child graph
// (its nested canvas), enabling drill-down from high-level to detailed slices.

// An opinionated, non-overlapping set of architectural element kinds. Each has a
// distinct color + icon in the renderer so a diagram reads at a glance. Old diagrams
// (and seeds) used a coarser set; `migrateKind` maps those forward on load.
export type ArchKind =
  | 'service'
  | 'gateway'
  | 'frontend'
  | 'database'
  | 'cache'
  | 'queue'
  | 'worker'
  | 'storage'
  | 'library'
  | 'external'
  | 'group';

export const ARCH_KINDS: { id: ArchKind; label: string }[] = [
  { id: 'service', label: 'Service' },
  { id: 'gateway', label: 'API / Gateway' },
  { id: 'frontend', label: 'UI / Frontend' },
  { id: 'database', label: 'Database' },
  { id: 'cache', label: 'Cache' },
  { id: 'queue', label: 'Queue / Event bus' },
  { id: 'worker', label: 'Job / Worker' },
  { id: 'storage', label: 'Storage / Blob' },
  { id: 'library', label: 'Library / Module' },
  { id: 'external', label: 'External system' },
  { id: 'group', label: 'Group / Boundary' },
];

const KIND_IDS = ARCH_KINDS.map((k) => k.id);
const isKind = (k: unknown): k is ArchKind =>
  typeof k === 'string' && (KIND_IDS as string[]).includes(k);

const DEFAULT_KIND: ArchKind = 'service';

// Back-compat: old kind ids (and a couple of synonyms the model never had as types but
// could appear in hand-written/legacy docs) mapped to the current set. Applied on load.
const OLD_TO_NEW: Record<string, ArchKind> = {
  service: 'service',
  logic: 'service',
  ui: 'frontend',
  view: 'frontend',
  data: 'database',
  store: 'database',
  external: 'external',
  group: 'group',
  layer: 'group',
  note: 'group',
};

/**
 * Resolve any stored kind (current id, legacy id, or unknown/missing) to a current
 * `ArchKind`. Current ids pass through; legacy ids map via `OLD_TO_NEW`; anything else
 * falls back to the default kind. Pure — safe to call while loading untrusted docs.
 */
export function migrateKind(kind: unknown): ArchKind {
  if (isKind(kind)) return kind;
  if (typeof kind === 'string' && OLD_TO_NEW[kind]) return OLD_TO_NEW[kind];
  return DEFAULT_KIND;
}

// Ports & the typed-interface model (spec 2026-07-06-arch-foundation-ports-types).
export type PrimitiveName = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'any';

export type TypeRef =
  | { kind: 'primitive'; name: PrimitiveName }
  | { kind: 'list'; of: TypeRef }
  | { kind: 'ref'; interfaceId: string };

export type PortDirection = 'in' | 'out';

export interface Port {
  id: string; // stable, unique within its node+direction
  name: string;
  type?: TypeRef; // undefined = untyped
  description?: string;
}

export interface InterfaceField {
  name: string;
  type: TypeRef; // required — a dangling ref clears to primitive `any`, never dropped
  optional?: boolean;
  description?: string;
}

export interface InterfaceDef {
  id: string;
  name: string;
  description?: string;
  fields: InterfaceField[];
}

export interface ArchNode {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  kind: ArchKind;
  x: number;
  y: number;
  childGraph?: string; // id of the nested graph this node drills into
  inputs?: Port[]; // ordered input ports (left edge)
  outputs?: Port[]; // ordered output ports (right edge)
  icon?: string; // glyph key; unset → kind default (authored in slice A)
}

export interface ArchEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  sourcePort?: string; // output Port.id on `source` (undefined = legacy whole-node edge)
  targetPort?: string; // input Port.id on `target`
}

// A named visual cluster at the SAME level as its members (spec D) — cosmetic grouping, not a
// structural nest (that's a complex component's childGraph). Has no interface; the box is derived
// from member positions at render time. A node belongs to at most one group.
export interface ArchGroup {
  id: string;
  label: string;
  memberIds: string[];
}

export interface ArchGraph {
  id: string;
  title: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
  groups?: ArchGroup[];
}

export interface ArchDoc {
  version: number;
  rootGraph: string;
  graphs: Record<string, ArchGraph>;
  interfaces?: Record<string, InterfaceDef>; // document-level type registry, keyed by id
}

const VERSION = 1;

let idCounter = 0;
const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function getGraph(doc: ArchDoc, graphId: string): ArchGraph | undefined {
  return doc.graphs[graphId];
}

/** Add a node to a graph at (x,y). Returns the new doc and the created node id. */
export function addNode(
  doc: ArchDoc,
  graphId: string,
  partial: { title?: string; kind?: ArchKind; x?: number; y?: number; subtitle?: string } = {},
): { doc: ArchDoc; id: string } {
  const g = doc.graphs[graphId];
  if (!g) return { doc, id: '' };
  const node: ArchNode = {
    id: newId('node'),
    title: partial.title?.trim() || 'New component',
    kind: partial.kind ?? 'service',
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    subtitle: partial.subtitle,
  };
  return {
    doc: { ...doc, graphs: { ...doc.graphs, [graphId]: { ...g, nodes: [...g.nodes, node] } } },
    id: node.id,
  };
}

export function updateNode(
  doc: ArchDoc,
  graphId: string,
  nodeId: string,
  patch: Partial<Omit<ArchNode, 'id'>>,
): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g) return doc;
  return {
    ...doc,
    graphs: {
      ...doc.graphs,
      [graphId]: { ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) },
    },
  };
}

/** Move (set position) — kept separate so callers reading intent are clear. */
export function moveNode(
  doc: ArchDoc,
  graphId: string,
  nodeId: string,
  x: number,
  y: number,
): ArchDoc {
  return updateNode(doc, graphId, nodeId, { x, y });
}

/**
 * Insert-space (spec D §2.6): shift every node on the far side of a guide line by `delta` along one
 * axis, opening (delta > 0) or tightening (delta < 0) a band of space. The test coordinate is the
 * node's top-left origin. A node with `coord < origin` stays; one with `coord >= origin` shifts. A
 * tightening shift is clamped so an affected node reaches the guide but never crosses `origin` into
 * the near cluster. Groups re-derive from members, so a straddling group simply stretches. Pure.
 */
export function insertSpace(
  doc: ArchDoc,
  graphId: string,
  axis: 'x' | 'y',
  origin: number,
  delta: number,
): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g || delta === 0) return doc;
  const nodes = g.nodes.map((n) => {
    const coord = axis === 'x' ? n.x : n.y;
    if (coord < origin) return n;
    const shifted = delta < 0 ? Math.max(origin, coord + delta) : coord + delta;
    return axis === 'x' ? { ...n, x: shifted } : { ...n, y: shifted };
  });
  return { ...doc, graphs: { ...doc.graphs, [graphId]: { ...g, nodes } } };
}

/** Collect a graph id and all graph ids reachable through its nodes' childGraphs. */
function descendantGraphIds(doc: ArchDoc, graphId: string, acc = new Set<string>()): Set<string> {
  const g = doc.graphs[graphId];
  if (!g || acc.has(graphId)) return acc;
  acc.add(graphId);
  for (const n of g.nodes) if (n.childGraph) descendantGraphIds(doc, n.childGraph, acc);
  return acc;
}

/** Remove a node, its incident edges, and (recursively) its nested child graphs. */
export function removeNode(doc: ArchDoc, graphId: string, nodeId: string): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g) return doc;
  const node = g.nodes.find((n) => n.id === nodeId);
  const graphs = { ...doc.graphs };
  if (node?.childGraph)
    for (const id of descendantGraphIds(doc, node.childGraph)) delete graphs[id];
  const next: ArchGraph = {
    ...g,
    nodes: g.nodes.filter((n) => n.id !== nodeId),
    edges: g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
  };
  // Prune the removed node from any group; a group emptied by the removal is dropped (spec D).
  if (g.groups) {
    const pruned = pruneGroups(g.groups, (id) => id !== nodeId);
    if (pruned.length) next.groups = pruned;
    else next.groups = undefined;
  }
  graphs[graphId] = next;
  return { ...doc, graphs };
}

/** Drop members failing `keep`, then drop any group left with no members (spec D auto-remove). */
function pruneGroups(groups: ArchGroup[], keep: (nodeId: string) => boolean): ArchGroup[] {
  return groups
    .map((gr) => ({ ...gr, memberIds: gr.memberIds.filter(keep) }))
    .filter((gr) => gr.memberIds.length > 0);
}

export function addEdge(
  doc: ArchDoc,
  graphId: string,
  source: string,
  target: string,
  label?: string,
): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g || source === target) return doc;
  if (g.edges.some((e) => e.source === source && e.target === target)) return doc; // no duplicates
  const edge: ArchEdge = { id: newId('edge'), source, target, label };
  return { ...doc, graphs: { ...doc.graphs, [graphId]: { ...g, edges: [...g.edges, edge] } } };
}

export function removeEdge(doc: ArchDoc, graphId: string, edgeId: string): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g) return doc;
  return {
    ...doc,
    graphs: { ...doc.graphs, [graphId]: { ...g, edges: g.edges.filter((e) => e.id !== edgeId) } },
  };
}

/**
 * Set (or clear) an edge's label. Trims the text; an empty/whitespace-only label
 * clears the property entirely (so it round-trips as `undefined`). No-ops on an
 * unknown graph or edge id. Pure — never mutates the input doc.
 */
export function setEdgeLabel(
  doc: ArchDoc,
  graphId: string,
  edgeId: string,
  label: string,
): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g) return doc;
  if (!g.edges.some((e) => e.id === edgeId)) return doc;
  const trimmed = label.trim();
  const edges = g.edges.map((e) => {
    if (e.id !== edgeId) return e;
    if (!trimmed) {
      const { label: _drop, ...rest } = e;
      return rest;
    }
    return { ...e, label: trimmed };
  });
  return { ...doc, graphs: { ...doc.graphs, [graphId]: { ...g, edges } } };
}

/** Short human label for a type ref (e.g. `string`, `User`, `User[]`), or '' when untyped. */
export function formatTypeRef(
  type: TypeRef | undefined,
  interfaces?: Record<string, InterfaceDef>,
): string {
  if (!type) return '';
  if (type.kind === 'primitive') return type.name;
  if (type.kind === 'list') return `${formatTypeRef(type.of, interfaces) || 'any'}[]`;
  return interfaces?.[type.interfaceId]?.name ?? 'ref';
}

// ---- Ports (spec F §Behavior) ---------------------------------------------------------------

const portListKey = (dir: PortDirection): 'inputs' | 'outputs' =>
  dir === 'in' ? 'inputs' : 'outputs';

/** Patch a single node in a graph (internal helper for the port reducers). */
function patchNode(
  doc: ArchDoc,
  graphId: string,
  nodeId: string,
  fn: (n: ArchNode) => ArchNode,
): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g) return doc;
  return {
    ...doc,
    graphs: {
      ...doc.graphs,
      [graphId]: { ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? fn(n) : n)) },
    },
  };
}

/** Add a port to a node's input or output list. Returns the doc and the new port id. */
export function addPort(
  doc: ArchDoc,
  graphId: string,
  nodeId: string,
  dir: PortDirection,
  partial: { name?: string; type?: TypeRef } = {},
): { doc: ArchDoc; portId: string } {
  const g = doc.graphs[graphId];
  const node = g?.nodes.find((n) => n.id === nodeId);
  if (!g || !node) return { doc, portId: '' };
  const key = portListKey(dir);
  const list = node[key] ?? [];
  const port: Port = {
    id: newId('port'),
    name: partial.name?.trim() || `${dir === 'in' ? 'in' : 'out'}${list.length + 1}`,
    type: partial.type,
  };
  return {
    doc: patchNode(doc, graphId, nodeId, (n) => ({ ...n, [key]: [...(n[key] ?? []), port] })),
    portId: port.id,
  };
}

function mapPort(node: ArchNode, portId: string, fn: (p: Port) => Port): ArchNode {
  const inputs = node.inputs?.map((p) => (p.id === portId ? fn(p) : p));
  const outputs = node.outputs?.map((p) => (p.id === portId ? fn(p) : p));
  return { ...node, ...(inputs ? { inputs } : {}), ...(outputs ? { outputs } : {}) };
}

/** Rename a port; a blank name is rejected (a port must keep a name). */
export function renamePort(
  doc: ArchDoc,
  graphId: string,
  nodeId: string,
  portId: string,
  name: string,
): ArchDoc {
  const trimmed = name.trim();
  if (!trimmed) return doc;
  return patchNode(doc, graphId, nodeId, (n) =>
    mapPort(n, portId, (p) => ({ ...p, name: trimmed })),
  );
}

/** Set (or clear, with `undefined`) a port's type. */
export function setPortType(
  doc: ArchDoc,
  graphId: string,
  nodeId: string,
  portId: string,
  type: TypeRef | undefined,
): ArchDoc {
  return patchNode(doc, graphId, nodeId, (n) =>
    mapPort(n, portId, (p) => {
      if (!type) {
        const { type: _drop, ...rest } = p;
        return rest;
      }
      return { ...p, type };
    }),
  );
}

/** Remove a port and any edges incident on it (including boundary edges). */
export function removePort(doc: ArchDoc, graphId: string, nodeId: string, portId: string): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g) return doc;
  const nodes = g.nodes.map((n) =>
    n.id === nodeId
      ? {
          ...n,
          ...(n.inputs ? { inputs: n.inputs.filter((p) => p.id !== portId) } : {}),
          ...(n.outputs ? { outputs: n.outputs.filter((p) => p.id !== portId) } : {}),
        }
      : n,
  );
  const edges = g.edges.filter(
    (e) =>
      !(
        (e.source === nodeId && e.sourcePort === portId) ||
        (e.target === nodeId && e.targetPort === portId)
      ),
  );
  return { ...doc, graphs: { ...doc.graphs, [graphId]: { ...g, nodes, edges } } };
}

/** Wire an output port to an input port. De-dupes an identical connection; no self-loop. */
export function addTypedEdge(
  doc: ArchDoc,
  graphId: string,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
  label?: string,
): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g || source === target) return doc;
  if (
    g.edges.some(
      (e) =>
        e.source === source &&
        e.sourcePort === sourcePort &&
        e.target === target &&
        e.targetPort === targetPort,
    )
  )
    return doc;
  const edge: ArchEdge = { id: newId('edge'), source, sourcePort, target, targetPort, label };
  return { ...doc, graphs: { ...doc.graphs, [graphId]: { ...g, edges: [...g.edges, edge] } } };
}

// ---- Interfaces (document-level type registry) ----------------------------------------------

/** Create an interface in the registry. Returns the doc and the new interface id. */
export function addInterface(
  doc: ArchDoc,
  partial: { name?: string; description?: string; fields?: InterfaceField[] } = {},
): { doc: ArchDoc; id: string } {
  const id = newId('iface');
  const iface: InterfaceDef = {
    id,
    name: partial.name?.trim() || 'Interface',
    description: partial.description,
    fields: partial.fields ?? [],
  };
  return {
    doc: { ...doc, interfaces: { ...(doc.interfaces ?? {}), [id]: iface } },
    id,
  };
}

/** Replace an interface's field list wholesale. */
export function updateInterfaceFields(doc: ArchDoc, id: string, fields: InterfaceField[]): ArchDoc {
  const iface = doc.interfaces?.[id];
  if (!iface) return doc;
  return { ...doc, interfaces: { ...doc.interfaces, [id]: { ...iface, fields } } };
}

/** Rename an interface; a blank name is rejected (revert). `name` is display-only — refs are
 *  by id, so renaming never breaks a consumer. */
export function renameInterface(doc: ArchDoc, id: string, name: string): ArchDoc {
  const iface = doc.interfaces?.[id];
  const trimmed = name.trim();
  if (!iface || !trimmed) return doc;
  return { ...doc, interfaces: { ...doc.interfaces, [id]: { ...iface, name: trimmed } } };
}

/** Append a field to an interface (default name `field{n}`, default type primitive `string` —
 *  a field's type is required, so it never lands undefined). */
export function addInterfaceField(
  doc: ArchDoc,
  id: string,
  partial: { name?: string; type?: TypeRef; optional?: boolean } = {},
): ArchDoc {
  const iface = doc.interfaces?.[id];
  if (!iface) return doc;
  const field: InterfaceField = {
    name: partial.name?.trim() || `field${iface.fields.length + 1}`,
    type: partial.type ?? { kind: 'primitive', name: 'string' },
    ...(partial.optional ? { optional: true } : {}),
  };
  return updateInterfaceFields(doc, id, [...iface.fields, field]);
}

/** Patch a single field by index. A blank name reverts (a field must keep a name); an
 *  `optional:false` / empty description normalizes away so it round-trips as undefined. */
export function updateInterfaceField(
  doc: ArchDoc,
  id: string,
  index: number,
  patch: Partial<InterfaceField>,
): ArchDoc {
  const iface = doc.interfaces?.[id];
  if (!iface || index < 0 || index >= iface.fields.length) return doc;
  const fields = iface.fields.map((f, i) => {
    if (i !== index) return f;
    const next: InterfaceField = { ...f, ...patch };
    if (patch.name !== undefined) {
      const t = patch.name.trim();
      if (!t) return f;
      next.name = t;
    }
    if (next.optional !== true) next.optional = undefined;
    if (next.description !== undefined && !next.description.trim()) next.description = undefined;
    return next;
  });
  return updateInterfaceFields(doc, id, fields);
}

/** Remove a field by index. */
export function removeInterfaceField(doc: ArchDoc, id: string, index: number): ArchDoc {
  const iface = doc.interfaces?.[id];
  if (!iface || index < 0 || index >= iface.fields.length) return doc;
  return updateInterfaceFields(
    doc,
    id,
    iface.fields.filter((_, i) => i !== index),
  );
}

/** Move a field from one index to another (pure array move). No-op when equal or out of range. */
export function moveInterfaceField(doc: ArchDoc, id: string, from: number, to: number): ArchDoc {
  const iface = doc.interfaces?.[id];
  if (!iface) return doc;
  const n = iface.fields.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return doc;
  const fields = [...iface.fields];
  const [moved] = fields.splice(from, 1);
  fields.splice(to, 0, moved);
  return updateInterfaceFields(doc, id, fields);
}

/**
 * Count how many ports and interface fields reference each interface (looking through `list`
 * wrappers). Walks TypeRef trees (finite) not the interface graph, so a cyclic registry can't
 * hang it. Returns id → count for every interface in the registry.
 */
export function interfaceUsage(doc: ArchDoc): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of Object.keys(doc.interfaces ?? {})) counts[id] = 0;
  const bump = (t: TypeRef | undefined): void => {
    if (!t) return;
    if (t.kind === 'ref') counts[t.interfaceId] = (counts[t.interfaceId] ?? 0) + 1;
    else if (t.kind === 'list') bump(t.of);
  };
  for (const g of Object.values(doc.graphs)) {
    for (const n of g.nodes) {
      for (const p of n.inputs ?? []) bump(p.type);
      for (const p of n.outputs ?? []) bump(p.type);
    }
  }
  for (const iface of Object.values(doc.interfaces ?? {}))
    for (const f of iface.fields) bump(f.type);
  return counts;
}

/** True when `t` (recursively) references interface `id`. */
function typeRefsInterface(t: TypeRef | undefined, id: string): boolean {
  if (!t) return false;
  if (t.kind === 'ref') return t.interfaceId === id;
  if (t.kind === 'list') return typeRefsInterface(t.of, id);
  return false;
}

/**
 * Remove an interface and clear every reference to it: a **port** typed by it becomes untyped;
 * an interface **field** typed by it becomes primitive `any` (a field's type is required — spec F
 * invariant 3). Nested list refs collapse the same way.
 */
export function removeInterface(doc: ArchDoc, id: string): ArchDoc {
  if (!doc.interfaces?.[id]) return doc;
  const any: TypeRef = { kind: 'primitive', name: 'any' };
  const clearField = (t: TypeRef): TypeRef => {
    if (t.kind === 'ref') return t.interfaceId === id ? any : t;
    if (t.kind === 'list') return { kind: 'list', of: clearField(t.of) };
    return t;
  };
  const interfaces: Record<string, InterfaceDef> = {};
  for (const [key, iface] of Object.entries(doc.interfaces)) {
    if (key === id) continue;
    interfaces[key] = {
      ...iface,
      fields: iface.fields.map((f) => ({ ...f, type: clearField(f.type) })),
    };
  }
  const clearPort = (p: Port): Port => {
    if (p.type && typeRefsInterface(p.type, id)) {
      const { type: _drop, ...rest } = p;
      return rest;
    }
    return p;
  };
  const graphs: Record<string, ArchGraph> = {};
  for (const [gid, g] of Object.entries(doc.graphs)) {
    graphs[gid] = {
      ...g,
      nodes: g.nodes.map((n) => ({
        ...n,
        ...(n.inputs ? { inputs: n.inputs.map(clearPort) } : {}),
        ...(n.outputs ? { outputs: n.outputs.map(clearPort) } : {}),
      })),
    };
  }
  return { ...doc, interfaces, graphs };
}

// ---- Named groups (spec D) ------------------------------------------------------------------

/** Update a graph's `groups`, dropping the property entirely when the list is empty. */
function withGroups(g: ArchGraph, groups: ArchGroup[]): ArchGraph {
  const next = { ...g };
  if (groups.length) next.groups = groups;
  else next.groups = undefined;
  return next;
}

/**
 * Cluster the given nodes into a named group in `graphId`. Enforces one-group-per-node (the nodes
 * leave any group they were in), ignores ids not in the graph, and no-ops on an empty selection.
 */
export function addGroup(
  doc: ArchDoc,
  graphId: string,
  nodeIds: string[],
  label?: string,
): { doc: ArchDoc; groupId: string } {
  const g = doc.graphs[graphId];
  if (!g) return { doc, groupId: '' };
  const present = new Set(g.nodes.map((n) => n.id));
  const members = [...new Set(nodeIds.filter((id) => present.has(id)))];
  if (members.length === 0) return { doc, groupId: '' };
  const claimed = new Set(members);
  const kept = pruneGroups(g.groups ?? [], (id) => !claimed.has(id));
  const groupId = newId('grp');
  const group: ArchGroup = {
    id: groupId,
    label: label?.trim() || `Group ${(g.groups?.length ?? 0) + 1}`,
    memberIds: members,
  };
  return {
    doc: { ...doc, graphs: { ...doc.graphs, [graphId]: withGroups(g, [...kept, group]) } },
    groupId,
  };
}

/** Rename a group; a blank label reverts (a group must keep a label). */
export function renameGroup(
  doc: ArchDoc,
  graphId: string,
  groupId: string,
  label: string,
): ArchDoc {
  const g = doc.graphs[graphId];
  const trimmed = label.trim();
  if (!g?.groups || !trimmed) return doc;
  return {
    ...doc,
    graphs: {
      ...doc.graphs,
      [graphId]: {
        ...g,
        groups: g.groups.map((gr) => (gr.id === groupId ? { ...gr, label: trimmed } : gr)),
      },
    },
  };
}

/** Dissolve a group's box, keeping its member nodes (non-lossy — spec D). */
export function ungroup(doc: ArchDoc, graphId: string, groupId: string): ArchDoc {
  const g = doc.graphs[graphId];
  if (!g?.groups) return doc;
  return {
    ...doc,
    graphs: {
      ...doc.graphs,
      [graphId]: withGroups(
        g,
        g.groups.filter((gr) => gr.id !== groupId),
      ),
    },
  };
}

/** Delete a group AND its member nodes (lossy; each removal cascades its own child graph). */
export function removeGroup(doc: ArchDoc, graphId: string, groupId: string): ArchDoc {
  const group = doc.graphs[graphId]?.groups?.find((gr) => gr.id === groupId);
  if (!group) return doc;
  let nd = doc;
  for (const id of group.memberIds) nd = removeNode(nd, graphId, id);
  // removeNode prunes emptied groups, but guard against a group whose members were already gone.
  const g = nd.graphs[graphId];
  return g?.groups
    ? {
        ...nd,
        graphs: {
          ...nd.graphs,
          [graphId]: withGroups(
            g,
            g.groups.filter((gr) => gr.id !== groupId),
          ),
        },
      }
    : nd;
}

/** Ensure a node has a child graph (creating + linking one if absent). Returns the
 *  doc and the child graph id, so the caller can drill into it. */
export function ensureChildGraph(
  doc: ArchDoc,
  graphId: string,
  nodeId: string,
): { doc: ArchDoc; childGraph: string } {
  const g = doc.graphs[graphId];
  const node = g?.nodes.find((n) => n.id === nodeId);
  if (!g || !node) return { doc, childGraph: '' };
  if (node.childGraph && doc.graphs[node.childGraph]) return { doc, childGraph: node.childGraph };
  const childId = newId('graph');
  const child: ArchGraph = { id: childId, title: node.title, nodes: [], edges: [] };
  const linked = updateNode(doc, graphId, nodeId, { childGraph: childId });
  return {
    doc: { ...linked, graphs: { ...linked.graphs, [childId]: child } },
    childGraph: childId,
  };
}

/** The chain of graphs from the root down to `graphId` (for breadcrumbs). Returns
 *  [{id,title}] starting at root; empty if graphId is unreachable. */
export function breadcrumb(doc: ArchDoc, graphId: string): { id: string; title: string }[] {
  const path: { id: string; title: string }[] = [];
  const walk = (gid: string, trail: { id: string; title: string }[]): boolean => {
    const g = doc.graphs[gid];
    if (!g) return false;
    const here = [...trail, { id: gid, title: g.title }];
    if (gid === graphId) {
      path.push(...here);
      return true;
    }
    for (const n of g.nodes) if (n.childGraph && walk(n.childGraph, here)) return true;
    return false;
  };
  walk(doc.rootGraph, []);
  return path;
}

// ---- Composition: encapsulate a selection into a complex component (spec D) -----------------

/** Unique edges by their full (source,sourcePort,target,targetPort) tuple. */
function dedupEdges(edges: ArchEdge[]): ArchEdge[] {
  const seen = new Set<string>();
  const out: ArchEdge[] = [];
  for (const e of edges) {
    const key = `${e.source}|${e.sourcePort ?? ''}|${e.target}|${e.targetPort ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Name for an inferred component port, from the internal endpoint it represents. */
function inferredPortName(
  node: ArchNode | undefined,
  portId: string | undefined,
  fallback: string,
): string {
  if (node && portId) {
    const p = [...(node.inputs ?? []), ...(node.outputs ?? [])].find((x) => x.id === portId);
    if (p) return p.name;
  }
  if (node) return node.title;
  return fallback;
}

/**
 * Turn the selected nodes in `graphId` into one complex component: move them into a new child
 * graph, create a component node in their place, and infer its ports from the wires that crossed
 * the selection boundary (incoming → inputs, outgoing → outputs; grouped by internal endpoint so
 * fan-in collapses to one port). Crossing wires are re-pointed to the component in the parent and
 * to the boundary:in/out endpoints inside the child. Pure (spec D §encapsulate).
 */
export function encapsulateSelection(
  doc: ArchDoc,
  graphId: string,
  nodeIds: string[],
  pos?: { x: number; y: number },
): { doc: ArchDoc; componentId: string; childGraph: string } {
  const g = doc.graphs[graphId];
  const sel = new Set(nodeIds);
  const inside = g ? g.nodes.filter((n) => sel.has(n.id)) : [];
  if (!g || inside.length === 0) return { doc, componentId: '', childGraph: '' };

  const childId = newId('graph');
  const compId = newId('node');

  const internal: ArchEdge[] = [];
  const crossIn: ArchEdge[] = []; // external source → internal target (becomes an input)
  const crossOut: ArchEdge[] = []; // internal source → external target (becomes an output)
  const external: ArchEdge[] = [];
  for (const e of g.edges) {
    const si = sel.has(e.source);
    const ti = sel.has(e.target);
    if (si && ti) internal.push(e);
    else if (!si && ti) crossIn.push(e);
    else if (si && !ti) crossOut.push(e);
    else external.push(e);
  }

  const findInside = (id: string) => inside.find((n) => n.id === id);
  const inputs: Port[] = [];
  const outputs: Port[] = [];
  const inKey = new Map<string, string>();
  const outKey = new Map<string, string>();
  for (const e of crossIn) {
    const key = `${e.target}::${e.targetPort ?? ''}`;
    if (!inKey.has(key)) {
      const id = newId('port');
      inputs.push({
        id,
        name: inferredPortName(findInside(e.target), e.targetPort, `in${inputs.length + 1}`),
      });
      inKey.set(key, id);
    }
  }
  for (const e of crossOut) {
    const key = `${e.source}::${e.sourcePort ?? ''}`;
    if (!outKey.has(key)) {
      const id = newId('port');
      outputs.push({
        id,
        name: inferredPortName(findInside(e.source), e.sourcePort, `out${outputs.length + 1}`),
      });
      outKey.set(key, id);
    }
  }

  // Child graph: the selected nodes, their internal edges, and boundary edges for each crossing.
  const childEdges: ArchEdge[] = internal.map((e) => ({ ...e }));
  for (const e of crossIn) {
    childEdges.push({
      id: newId('edge'),
      source: 'boundary:in',
      sourcePort: inKey.get(`${e.target}::${e.targetPort ?? ''}`),
      target: e.target,
      ...(e.targetPort ? { targetPort: e.targetPort } : {}),
    });
  }
  for (const e of crossOut) {
    childEdges.push({
      id: newId('edge'),
      source: e.source,
      ...(e.sourcePort ? { sourcePort: e.sourcePort } : {}),
      target: 'boundary:out',
      targetPort: outKey.get(`${e.source}::${e.sourcePort ?? ''}`),
    });
  }
  const childGraph: ArchGraph = {
    id: childId,
    title: 'Component',
    nodes: inside.map((n) => ({ ...n })),
    edges: dedupEdges(childEdges),
  };

  // Parent graph: drop the selection + its edges; add the component node + re-pointed crossings.
  const cx = pos?.x ?? inside.reduce((s, n) => s + n.x, 0) / inside.length;
  const cy = pos?.y ?? inside.reduce((s, n) => s + n.y, 0) / inside.length;
  const compNode: ArchNode = {
    id: compId,
    title: 'Component',
    kind: 'service',
    x: cx,
    y: cy,
    childGraph: childId,
    ...(inputs.length ? { inputs } : {}),
    ...(outputs.length ? { outputs } : {}),
  };
  const parentEdges: ArchEdge[] = external.map((e) => ({ ...e }));
  for (const e of crossIn) {
    parentEdges.push({
      id: newId('edge'),
      source: e.source,
      ...(e.sourcePort ? { sourcePort: e.sourcePort } : {}),
      target: compId,
      targetPort: inKey.get(`${e.target}::${e.targetPort ?? ''}`),
    });
  }
  for (const e of crossOut) {
    parentEdges.push({
      id: newId('edge'),
      source: compId,
      sourcePort: outKey.get(`${e.source}::${e.sourcePort ?? ''}`),
      target: e.target,
      ...(e.targetPort ? { targetPort: e.targetPort } : {}),
    });
  }
  const parentGraph: ArchGraph = {
    ...g,
    nodes: g.nodes.filter((n) => !sel.has(n.id)).concat(compNode),
    edges: dedupEdges(parentEdges),
  };
  // The encapsulated nodes left this level, so prune them from any group here (spec D).
  if (g.groups) {
    const pruned = pruneGroups(g.groups, (id) => !sel.has(id));
    if (pruned.length) parentGraph.groups = pruned;
    else parentGraph.groups = undefined;
  }

  return {
    doc: { ...doc, graphs: { ...doc.graphs, [graphId]: parentGraph, [childId]: childGraph } },
    componentId: compId,
    childGraph: childId,
  };
}

/**
 * Explode a complex component back into its parent graph: promote the child graph's nodes (keeping
 * their own grandchild graphs), re-attach the internal wiring, rewire the parent edges that touched
 * the component's ports to the matching internal endpoints (via the boundary edges), then drop the
 * component node and ONLY its own child graph. The exact inverse of {@link encapsulateSelection}.
 *
 * Deliberately does NOT call `removeNode` — that cascade-deletes descendant child graphs, which here
 * belong to the promoted nodes and must survive (spec D). Pure.
 */
export function explodeComponent(doc: ArchDoc, graphId: string, componentId: string): ArchDoc {
  const parent = doc.graphs[graphId];
  const comp = parent?.nodes.find((n) => n.id === componentId);
  if (!parent || !comp?.childGraph) return doc;
  const child = doc.graphs[comp.childGraph];
  if (!child) return doc;

  // Boundary edges map a component port id ↔ the internal endpoint it stands in for.
  const inMap = new Map<string, { node: string; port?: string }>(); // compInputPort → internal target
  const outMap = new Map<string, { node: string; port?: string }>(); // compOutputPort → internal source
  const internalEdges: ArchEdge[] = [];
  for (const e of child.edges) {
    if (e.source === 'boundary:in') {
      if (e.sourcePort) inMap.set(e.sourcePort, { node: e.target, port: e.targetPort });
    } else if (e.target === 'boundary:out') {
      if (e.targetPort) outMap.set(e.targetPort, { node: e.source, port: e.sourcePort });
    } else {
      internalEdges.push(e);
    }
  }

  // Remap any child node id that would collide with a surviving parent node id. Grandchild links are
  // by `childGraph` (graph id), so remapping a node id never detaches its nested graph.
  const parentIds = new Set(parent.nodes.filter((n) => n.id !== componentId).map((n) => n.id));
  const idRemap = new Map<string, string>();
  for (const n of child.nodes) if (parentIds.has(n.id)) idRemap.set(n.id, newId('node'));
  const mapId = (id: string): string => idRemap.get(id) ?? id;

  // Lay the promoted nodes out relative to the component's position, preserving their internal layout.
  const baseX = child.nodes.length ? Math.min(...child.nodes.map((n) => n.x)) : 0;
  const baseY = child.nodes.length ? Math.min(...child.nodes.map((n) => n.y)) : 0;
  const promoted: ArchNode[] = child.nodes.map((n) => ({
    ...n,
    id: mapId(n.id),
    x: comp.x + (n.x - baseX),
    y: comp.y + (n.y - baseY),
  }));
  const promotedInternal: ArchEdge[] = internalEdges.map((e) => ({
    ...e,
    id: newId('edge'),
    source: mapId(e.source),
    target: mapId(e.target),
  }));

  const rewired: ArchEdge[] = [];
  for (const e of parent.edges) {
    if (e.target === componentId) {
      const dest = e.targetPort ? inMap.get(e.targetPort) : undefined;
      if (dest)
        rewired.push({
          id: newId('edge'),
          source: e.source,
          ...(e.sourcePort ? { sourcePort: e.sourcePort } : {}),
          target: mapId(dest.node),
          ...(dest.port ? { targetPort: dest.port } : {}),
          ...(e.label ? { label: e.label } : {}),
        });
    } else if (e.source === componentId) {
      const src = e.sourcePort ? outMap.get(e.sourcePort) : undefined;
      if (src)
        rewired.push({
          id: newId('edge'),
          source: mapId(src.node),
          ...(src.port ? { sourcePort: src.port } : {}),
          target: e.target,
          ...(e.targetPort ? { targetPort: e.targetPort } : {}),
          ...(e.label ? { label: e.label } : {}),
        });
    } else {
      rewired.push(e);
    }
  }

  const newParent: ArchGraph = {
    ...parent,
    nodes: parent.nodes.filter((n) => n.id !== componentId).concat(promoted),
    edges: dedupEdges([...rewired, ...promotedInternal]),
  };
  const graphs = { ...doc.graphs, [graphId]: newParent };
  delete graphs[comp.childGraph];
  return { ...doc, graphs };
}

/** The node (and its graph) that drills into `graphId`, or null for the root/an orphan graph. */
export function parentOf(
  doc: ArchDoc,
  graphId: string,
): { graphId: string; node: ArchNode } | null {
  for (const [gid, g] of Object.entries(doc.graphs)) {
    const node = g.nodes.find((n) => n.childGraph === graphId);
    if (node) return { graphId: gid, node };
  }
  return null;
}

export function serializeArchitecture(doc: ArchDoc): string {
  return JSON.stringify(
    {
      version: VERSION,
      rootGraph: doc.rootGraph,
      graphs: doc.graphs,
      ...(doc.interfaces ? { interfaces: doc.interfaces } : {}),
    },
    null,
    2,
  );
}

const PRIMITIVES = new Set<PrimitiveName>(['string', 'number', 'boolean', 'date', 'json', 'any']);
const isBoundaryId = (x: string): boolean => x === 'boundary:in' || x === 'boundary:out';

/** Validate a stored type ref (recursively); `undefined` when absent/malformed. */
function validTypeRef(raw: unknown): TypeRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as { kind?: unknown; name?: unknown; of?: unknown; interfaceId?: unknown };
  if (t.kind === 'primitive' && PRIMITIVES.has(t.name as PrimitiveName)) {
    return { kind: 'primitive', name: t.name as PrimitiveName };
  }
  if (t.kind === 'list') {
    const of = validTypeRef(t.of);
    return of ? { kind: 'list', of } : undefined;
  }
  if (t.kind === 'ref' && typeof t.interfaceId === 'string') {
    return { kind: 'ref', interfaceId: t.interfaceId };
  }
  return undefined;
}

/** Validate a node's ports; ids are de-duped across both directions via the shared `seen` set. */
function validPorts(raw: unknown, seen: Set<string>): Port[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ports: Port[] = [];
  for (const p of raw as Partial<Port>[]) {
    if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue;
    seen.add(p.id);
    ports.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name : 'port',
      type: validTypeRef(p.type),
      description: typeof p.description === 'string' ? p.description : undefined,
    });
  }
  return ports.length ? ports : undefined;
}

function validInterfaces(raw: unknown): Record<string, InterfaceDef> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, InterfaceDef> = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const iface = v as Partial<InterfaceDef>;
    if (!iface || typeof iface.id !== 'string') continue;
    const fields: InterfaceField[] = Array.isArray(iface.fields)
      ? (iface.fields as Partial<InterfaceField>[])
          .filter((f) => !!f && typeof f.name === 'string')
          .map((f) => ({
            name: f.name as string,
            type: validTypeRef(f.type) ?? { kind: 'primitive', name: 'any' },
            optional: f.optional === true ? true : undefined,
            description: typeof f.description === 'string' ? f.description : undefined,
          }))
      : [];
    out[key] = {
      id: iface.id,
      name: typeof iface.name === 'string' && iface.name.trim() ? iface.name : 'Interface',
      description: typeof iface.description === 'string' ? iface.description : undefined,
      fields,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function validGraph(raw: unknown): ArchGraph | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<ArchGraph>;
  if (typeof g.id !== 'string' || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  const nodes: ArchNode[] = g.nodes
    .filter((n): n is ArchNode => !!n && typeof (n as ArchNode).id === 'string')
    .map((n) => {
      const seen = new Set<string>();
      const inputs = validPorts(n.inputs, seen);
      const outputs = validPorts(n.outputs, seen);
      return {
        id: n.id,
        title: typeof n.title === 'string' ? n.title : 'Untitled',
        subtitle: typeof n.subtitle === 'string' ? n.subtitle : undefined,
        description: typeof n.description === 'string' ? n.description : undefined,
        kind: migrateKind(n.kind),
        x: Number.isFinite(n.x) ? n.x : 0,
        y: Number.isFinite(n.y) ? n.y : 0,
        childGraph: typeof n.childGraph === 'string' ? n.childGraph : undefined,
        ...(inputs ? { inputs } : {}),
        ...(outputs ? { outputs } : {}),
        ...(typeof n.icon === 'string' ? { icon: n.icon } : {}),
      };
    });
  const ids = new Set(nodes.map((n) => n.id));
  const outPorts = new Map<string, Set<string>>();
  const inPorts = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (n.outputs) outPorts.set(n.id, new Set(n.outputs.map((p) => p.id)));
    if (n.inputs) inPorts.set(n.id, new Set(n.inputs.map((p) => p.id)));
  }
  const edges: ArchEdge[] = g.edges
    .filter((e): e is ArchEdge => !!e && typeof (e as ArchEdge).id === 'string')
    .filter((e) => {
      // Endpoints must be a real node in this graph, or a boundary id (parent-owned, spec F).
      if (!(ids.has(e.source) || isBoundaryId(e.source))) return false;
      if (!(ids.has(e.target) || isBoundaryId(e.target))) return false;
      // A named port must exist on a real endpoint node (boundary ports are validated by the
      // renderer against the parent's ports, not here — this graph doesn't hold them).
      if (e.sourcePort && ids.has(e.source) && !outPorts.get(e.source)?.has(e.sourcePort)) {
        return false;
      }
      if (e.targetPort && ids.has(e.target) && !inPorts.get(e.target)?.has(e.targetPort)) {
        return false;
      }
      return true;
    })
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === 'string' ? e.label : undefined,
      ...(typeof e.sourcePort === 'string' ? { sourcePort: e.sourcePort } : {}),
      ...(typeof e.targetPort === 'string' ? { targetPort: e.targetPort } : {}),
    }));
  const groups = validGroups(g.groups, ids);
  return {
    id: g.id,
    title: typeof g.title === 'string' ? g.title : 'Architecture',
    nodes,
    edges,
    ...(groups ? { groups } : {}),
  };
}

/** Validate a graph's groups: members must be real node ids, a node lands in ≤1 group (first wins),
 *  empty-membered groups and blank labels are dropped/defaulted (spec D). */
function validGroups(raw: unknown, nodeIds: Set<string>): ArchGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const claimed = new Set<string>();
  const out: ArchGroup[] = [];
  for (const gr of raw as Partial<ArchGroup>[]) {
    if (!gr || typeof gr.id !== 'string' || !Array.isArray(gr.memberIds)) continue;
    const members = gr.memberIds.filter(
      (m): m is string => typeof m === 'string' && nodeIds.has(m) && !claimed.has(m),
    );
    if (members.length === 0) continue;
    for (const m of members) claimed.add(m);
    out.push({
      id: gr.id,
      label: typeof gr.label === 'string' && gr.label.trim() ? gr.label : 'Group',
      memberIds: members,
    });
  }
  return out.length ? out : undefined;
}

/** Restore from a blob; returns null when missing/invalid so callers can seed. */
export function restoreArchitecture(blob: string | undefined): ArchDoc | null {
  if (!blob) return null;
  try {
    const parsed = JSON.parse(blob);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.rootGraph !== 'string' ||
      !parsed.graphs
    )
      return null;
    const graphs: Record<string, ArchGraph> = {};
    for (const [key, raw] of Object.entries(parsed.graphs as Record<string, unknown>)) {
      const g = validGraph(raw);
      if (g) graphs[key] = g;
    }
    // Drop dangling childGraph references so navigation never dead-ends.
    for (const g of Object.values(graphs)) {
      for (const n of g.nodes) if (n.childGraph && !graphs[n.childGraph]) n.childGraph = undefined;
    }
    if (!graphs[parsed.rootGraph]) return null;
    let doc: ArchDoc = { version: VERSION, rootGraph: parsed.rootGraph, graphs };
    const interfaces = validInterfaces(parsed.interfaces);
    if (interfaces) doc = { ...doc, interfaces };
    // Clear refs to interfaces that don't exist (spec F invariant 3): a port ref → untyped;
    // an interface-field ref → primitive `any`. Reuse removeInterface's clearing per missing id.
    const known = new Set(Object.keys(doc.interfaces ?? {}));
    const missing = collectRefIds(doc).filter((id) => !known.has(id));
    for (const id of new Set(missing))
      doc = removeInterface(
        { ...doc, interfaces: { ...(doc.interfaces ?? {}), [id]: { id, name: '', fields: [] } } },
        id,
      );
    return doc;
  } catch {
    return null;
  }
}

/** Every interface id referenced by any port or interface field in the doc. */
function collectRefIds(doc: ArchDoc): string[] {
  const ids: string[] = [];
  const walk = (t: TypeRef | undefined) => {
    if (!t) return;
    if (t.kind === 'ref') ids.push(t.interfaceId);
    else if (t.kind === 'list') walk(t.of);
  };
  for (const g of Object.values(doc.graphs)) {
    for (const n of g.nodes) {
      for (const p of n.inputs ?? []) walk(p.type);
      for (const p of n.outputs ?? []) walk(p.type);
    }
  }
  for (const iface of Object.values(doc.interfaces ?? {}))
    for (const f of iface.fields) walk(f.type);
  return ids;
}

/** A starter document so a brand-new architecture is immediately useful/editable. */
export function seedArchitecture(projectName = 'System'): ArchDoc {
  const root = 'graph-root';
  return {
    version: VERSION,
    rootGraph: root,
    graphs: {
      [root]: {
        id: root,
        title: projectName,
        nodes: [
          {
            id: 'n-ui',
            title: 'UI / Renderer',
            subtitle: 'React webview',
            kind: 'frontend',
            x: 80,
            y: 80,
          },
          {
            id: 'n-core',
            title: 'Core / Host',
            subtitle: 'main process',
            kind: 'service',
            x: 380,
            y: 80,
          },
          {
            id: 'n-store',
            title: 'Persistence',
            subtitle: 'JSON on disk',
            kind: 'database',
            x: 380,
            y: 280,
          },
          {
            id: 'n-ext',
            title: 'CLI Agents',
            subtitle: 'external processes',
            kind: 'external',
            x: 80,
            y: 280,
          },
        ],
        edges: [
          { id: 'e1', source: 'n-ui', target: 'n-core', label: 'IPC' },
          { id: 'e2', source: 'n-core', target: 'n-store', label: 'read/write' },
          { id: 'e3', source: 'n-core', target: 'n-ext', label: 'spawn PTY' },
        ],
      },
    },
  };
}
