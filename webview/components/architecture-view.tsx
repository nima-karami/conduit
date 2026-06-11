import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEscapeKey } from '../use-escape-key';
import '@xyflow/react/dist/style.css';
import {
  ARCH_KINDS,
  type ArchDoc,
  type ArchKind,
  addEdge,
  addNode,
  breadcrumb,
  ensureChildGraph,
  getGraph,
  removeEdge,
  removeNode,
  seedArchitecture,
  updateNode,
} from '../../src/architecture';
import { post, subscribe } from '../bridge';
import { IconChevron, IconClose, IconPlus, IconTrash } from '../icons';

const KIND_VAR: Record<ArchKind, string> = {
  service: '--accent',
  ui: '--blue',
  data: '--green',
  external: '--amber',
  group: '--accent-2',
  note: '--text-faint',
};

interface ArchNodeData {
  title: string;
  subtitle?: string;
  kind: ArchKind;
  hasChild: boolean;
  onDrill: (id: string) => void;
  [key: string]: unknown;
}

/** Custom React Flow node: a component card with a kind stripe + drill-in affordance. */
function ArchNodeCard({ id, data, selected }: NodeProps) {
  const d = data as ArchNodeData;
  return (
    <div className={`archnode archnode--${d.kind} ${selected ? 'archnode--sel' : ''}`}>
      <span className="archnode__stripe" style={{ background: `var(${KIND_VAR[d.kind]})` }} />
      <Handle type="target" position={Position.Left} className="archnode__handle" />
      <div className="archnode__body">
        <div className="archnode__title">{d.title}</div>
        {d.subtitle && <div className="archnode__sub">{d.subtitle}</div>}
      </div>
      <button
        className={`archnode__drill ${d.hasChild ? 'archnode__drill--has' : ''}`}
        title={d.hasChild ? 'Open nested canvas' : 'Create nested canvas'}
        onClick={(e) => {
          e.stopPropagation();
          d.onDrill(id);
        }}
      >
        <IconChevron size={13} />
      </button>
      <Handle type="source" position={Position.Right} className="archnode__handle" />
    </div>
  );
}

const nodeTypes = { arch: ArchNodeCard };

/** A visible mid-gray used whenever a kind color can't be resolved — never transparent. */
const MINIMAP_FALLBACK_COLOR = '#8a8a8a';

/**
 * Resolve a node's kind to a concrete CSS color for the minimap.
 *
 * React Flow's <MiniMap> renders each silhouette as an SVG <rect fill={nodeColor(node)}>.
 * SVG `fill` does NOT resolve CSS custom properties the way a DOM `background` does, so a
 * bare `var(--accent)` paints as transparent — which is the main reason the minimap looked
 * empty. We read the computed value of the kind's design variable off the live document and
 * hand the MiniMap a concrete color string instead.
 */
function archNodeColor(node: Node): string {
  const kind = (node.data as ArchNodeData)?.kind;
  const cssVar = (kind && KIND_VAR[kind]) || '--text-faint';
  if (typeof window !== 'undefined') {
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    if (resolved) return resolved;
  }
  return MINIMAP_FALLBACK_COLOR;
}

function Canvas({
  projectPath,
  projectName,
  onClose,
}: {
  projectPath?: string;
  projectName?: string;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<ArchDoc>(() => seedArchitecture(projectName || 'System'));
  const [graphId, setGraphId] = useState<string>(() => doc.rootGraph);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Per-node measured size from React Flow. The `nodes` prop is fully rebuilt from `doc` on
  // every render, which wipes React Flow's measured dimensions — and the <MiniMap> skips any
  // node without dimensions, so silhouettes never render. We capture `dimensions` changes here
  // and feed them back as explicit width/height so the layout survives the rebuild.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const docRef = useRef(doc);
  docRef.current = doc;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rf = useReactFlow();
  const nodesReady = useNodesInitialized();

  // Fit the view once the custom nodes have been measured (and on graph change),
  // so fitView doesn't zoom to a degenerate bounds before nodes have a size.
  useEffect(() => {
    if (nodesReady) rf.fitView({ padding: 0.25, maxZoom: 1.2, duration: 200 });
  }, [nodesReady, rf]);

  // Load the project's architecture (or seed if none); subscribe for the reply.
  useEffect(() => {
    if (projectPath) post({ type: 'requestArchitecture', path: projectPath });
    return subscribe((msg) => {
      if (msg.type === 'architecture' && (!projectPath || msg.path === projectPath)) {
        const loaded = msg.doc ?? seedArchitecture(projectName || 'System');
        setDoc(loaded);
        setGraphId(loaded.rootGraph);
        setSelectedId(null);
      }
    });
  }, [projectPath, projectName]);

  useEscapeKey(onClose);

  const scheduleSave = useCallback(
    (next: ArchDoc) => {
      if (!projectPath) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => post({ type: 'updateArchitecture', path: projectPath, doc: next }),
        300,
      );
    },
    [projectPath],
  );

  const applyDoc = useCallback(
    (updater: (d: ArchDoc) => ArchDoc) => {
      const next = updater(docRef.current);
      docRef.current = next;
      setDoc(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  const drillInto = useCallback(
    (nodeId: string) => {
      const { doc: next, childGraph } = ensureChildGraph(docRef.current, graphId, nodeId);
      if (!childGraph) return;
      applyDoc(() => next);
      setSelectedId(null);
      setGraphId(childGraph);
    },
    [graphId, applyDoc],
  );

  const graph = getGraph(doc, graphId);

  const rfNodes: Node[] = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.map((n) => ({
      id: n.id,
      type: 'arch',
      position: { x: n.x, y: n.y },
      selected: n.id === selectedId,
      // Persist the measured size so the rebuilt node keeps dimensions React Flow already
      // measured — otherwise the <MiniMap> can't compute a silhouette and renders nothing.
      ...(sizes[n.id] ? { width: sizes[n.id].width, height: sizes[n.id].height } : {}),
      data: {
        title: n.title,
        subtitle: n.subtitle,
        kind: n.kind,
        hasChild: !!n.childGraph,
        onDrill: drillInto,
      } as ArchNodeData,
    }));
  }, [graph, selectedId, drillInto, sizes]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
  }, [graph]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Capture measured dimensions so the MiniMap can draw node silhouettes (see `sizes`).
      const dims = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
      if (dims.length)
        setSizes((prev) => {
          const merged = { ...prev };
          let changed = false;
          for (const c of dims) {
            if (c.type !== 'dimensions' || !c.dimensions) continue;
            const { width, height } = c.dimensions;
            if (merged[c.id]?.width !== width || merged[c.id]?.height !== height) {
              merged[c.id] = { width, height };
              changed = true;
            }
          }
          return changed ? merged : prev;
        });

      applyDoc((d) => {
        let nd = d;
        for (const c of changes) {
          if (c.type === 'position' && c.position)
            nd = updateNode(nd, graphId, c.id, { x: c.position.x, y: c.position.y });
          else if (c.type === 'remove') nd = removeNode(nd, graphId, c.id);
        }
        return nd;
      });
    },
    [graphId, applyDoc],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      applyDoc((d) => {
        let nd = d;
        for (const c of changes) if (c.type === 'remove') nd = removeEdge(nd, graphId, c.id);
        return nd;
      });
    },
    [graphId, applyDoc],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const { source, target } = c;
      if (source && target) applyDoc((d) => addEdge(d, graphId, source, target));
    },
    [graphId, applyDoc],
  );

  const addComponent = useCallback(() => {
    let pos = { x: 120, y: 120 };
    try {
      pos = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    } catch {
      /* not mounted */
    }
    let createdId = '';
    applyDoc((d) => {
      const r = addNode(d, graphId, { x: pos.x - 90, y: pos.y - 30 });
      createdId = r.id;
      return r.doc;
    });
    if (createdId) setSelectedId(createdId);
  }, [graphId, applyDoc, rf]);

  const crumbs = breadcrumb(doc, graphId);
  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="arch">
      <div className="arch__head">
        <div className="arch__crumbs">
          {crumbs.map((c, i) => (
            <span key={c.id} className="arch__crumb">
              {i > 0 && <span className="arch__crumbsep">›</span>}
              <button
                className={`arch__crumbbtn ${i === crumbs.length - 1 ? 'arch__crumbbtn--active' : ''}`}
                onClick={() => {
                  setSelectedId(null);
                  setGraphId(c.id);
                }}
              >
                {c.title}
              </button>
            </span>
          ))}
        </div>
        <span className="arch__sub">
          Architecture · drag to connect, double-click a card to drill in
        </span>
        <button className="btn arch__add" onClick={addComponent}>
          <IconPlus size={13} /> Component
        </button>
        <button className="iconbtn" aria-label="Close architecture" onClick={onClose}>
          <IconClose size={15} />
        </button>
      </div>

      <div className="arch__body">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onNodeDoubleClick={(_e, n) => drillInto(n.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background gap={20} size={1} color="var(--border-2)" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            className="arch__minimap"
            style={{ width: 190, height: 128 }}
            nodeColor={archNodeColor}
            nodeStrokeColor={archNodeColor}
            nodeStrokeWidth={2}
            nodeBorderRadius={4}
            maskColor="rgba(0, 0, 0, 0.55)"
          />
        </ReactFlow>

        {selected && (
          <Inspector
            key={selected.id}
            title={selected.title}
            subtitle={selected.subtitle ?? ''}
            kind={selected.kind}
            description={selected.description ?? ''}
            hasChild={!!selected.childGraph}
            onChange={(patch) => applyDoc((d) => updateNode(d, graphId, selected.id, patch))}
            onDrill={() => drillInto(selected.id)}
            onDelete={() => {
              applyDoc((d) => removeNode(d, graphId, selected.id));
              setSelectedId(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function Inspector({
  title,
  subtitle,
  kind,
  description,
  hasChild,
  onChange,
  onDrill,
  onDelete,
}: {
  title: string;
  subtitle: string;
  kind: ArchKind;
  description: string;
  hasChild: boolean;
  onChange: (patch: {
    title?: string;
    subtitle?: string;
    kind?: ArchKind;
    description?: string;
  }) => void;
  onDrill: () => void;
  onDelete: () => void;
}) {
  return (
    <aside className="arch__inspector">
      <div className="arch__insphead">Component</div>
      <label className="arch__field">
        <span>Title</span>
        <input value={title} onChange={(e) => onChange({ title: e.target.value })} />
      </label>
      <label className="arch__field">
        <span>Subtitle</span>
        <input
          value={subtitle}
          placeholder="role / tech…"
          onChange={(e) => onChange({ subtitle: e.target.value })}
        />
      </label>
      <label className="arch__field">
        <span>Kind</span>
        <select value={kind} onChange={(e) => onChange({ kind: e.target.value as ArchKind })}>
          {ARCH_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="arch__field">
        <span>Notes</span>
        <textarea
          value={description}
          placeholder="What does this do? Constraints, decisions…"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </label>
      <button className="btn arch__drillbtn" onClick={onDrill}>
        <IconChevron size={13} /> {hasChild ? 'Open nested canvas' : 'Create nested canvas'}
      </button>
      <button className="btn btn--danger arch__delbtn" onClick={onDelete}>
        <IconTrash size={13} /> Delete component
      </button>
    </aside>
  );
}

export function ArchitectureView(props: {
  projectPath?: string;
  projectName?: string;
  onClose: () => void;
}) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
