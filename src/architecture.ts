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

export interface ArchNode {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  kind: ArchKind;
  x: number;
  y: number;
  childGraph?: string; // id of the nested graph this node drills into
}

export interface ArchEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface ArchGraph {
  id: string;
  title: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
}

export interface ArchDoc {
  version: number;
  rootGraph: string;
  graphs: Record<string, ArchGraph>;
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
  graphs[graphId] = {
    ...g,
    nodes: g.nodes.filter((n) => n.id !== nodeId),
    edges: g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
  };
  return { ...doc, graphs };
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

export function serializeArchitecture(doc: ArchDoc): string {
  return JSON.stringify(
    { version: VERSION, rootGraph: doc.rootGraph, graphs: doc.graphs },
    null,
    2,
  );
}

function validGraph(raw: unknown): ArchGraph | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<ArchGraph>;
  if (typeof g.id !== 'string' || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  const nodes: ArchNode[] = g.nodes
    .filter((n): n is ArchNode => !!n && typeof (n as ArchNode).id === 'string')
    .map((n) => ({
      id: n.id,
      title: typeof n.title === 'string' ? n.title : 'Untitled',
      subtitle: typeof n.subtitle === 'string' ? n.subtitle : undefined,
      description: typeof n.description === 'string' ? n.description : undefined,
      kind: migrateKind(n.kind),
      x: Number.isFinite(n.x) ? n.x : 0,
      y: Number.isFinite(n.y) ? n.y : 0,
      childGraph: typeof n.childGraph === 'string' ? n.childGraph : undefined,
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: ArchEdge[] = g.edges
    .filter((e): e is ArchEdge => !!e && typeof (e as ArchEdge).id === 'string')
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === 'string' ? e.label : undefined,
    }));
  return { id: g.id, title: typeof g.title === 'string' ? g.title : 'Architecture', nodes, edges };
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
    return { version: VERSION, rootGraph: parsed.rootGraph, graphs };
  } catch {
    return null;
  }
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
