import {
  Background,
  BaseEdge,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
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
import { useDebouncedFlush } from '../use-debounced-flush';
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
  migrateKind,
  removeEdge,
  removeNode,
  seedArchitecture,
  setEdgeLabel,
  updateNode,
} from '../../src/architecture';
import { type ArchDiff, diffArchitecture } from '../../src/conduit-proposal';
import { post, subscribe } from '../bridge';
import {
  IconChevron,
  IconDuplicate,
  IconGraph,
  IconPencil,
  IconPlus,
  IconTrash,
  KIND_ICON,
} from '../icons';
import { ContextMenu, type MenuState } from './context-menu';
import { ArchProposalBanner } from './proposal-banner';

const KIND_VAR: Record<ArchKind, string> = {
  service: '--accent',
  gateway: '--accent-2',
  frontend: '--blue',
  database: '--green',
  cache: '--amber',
  queue: '--violet',
  worker: '--blue',
  storage: '--green',
  library: '--text-dim',
  external: '--red',
  group: '--text-faint',
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
  const KindIcon = KIND_ICON[d.kind];
  return (
    <div className={`archnode archnode--${d.kind} ${selected ? 'archnode--sel' : ''}`}>
      <span className="archnode__stripe" style={{ background: `var(${KIND_VAR[d.kind]})` }} />
      <Handle type="target" position={Position.Left} className="archnode__handle" />
      <span className="archnode__icon" style={{ color: `var(${KIND_VAR[d.kind]})` }} aria-hidden>
        {KindIcon && <KindIcon size={15} />}
      </span>
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

interface ArchEdgeData {
  label?: string;
  editing: boolean;
  onStartEdit: (id: string) => void;
  onCommit: (id: string, label: string) => void;
  onCancel: () => void;
  [key: string]: unknown;
}

/**
 * Custom edge with an inline editable label (double-click to edit, Enter/blur commit, Esc
 * cancel, empty clears). Edit state lives in <Canvas> and is threaded via edge data so the
 * editor survives the per-render rebuild of `edges` from `doc`.
 */
function ArchEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const d = data as ArchEdgeData;
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        {d.editing ? (
          <EdgeLabelInput
            initial={d.label ?? ''}
            x={labelX}
            y={labelY}
            onCommit={(text) => d.onCommit(id, text)}
            onCancel={d.onCancel}
          />
        ) : (
          (d.label || '') && (
            <div
              className="archedge__label nodrag nopan"
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                d.onStartEdit(id);
              }}
              title="Double-click to edit label"
            >
              {d.label}
            </div>
          )
        )}
      </EdgeLabelRenderer>
    </>
  );
}

/** The inline text input shown while an edge label is being edited. */
function EdgeLabelInput({
  initial,
  x,
  y,
  onCommit,
  onCancel,
}: {
  initial: string;
  x: number;
  y: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="archedge__input nodrag nopan"
      autoFocus
      value={value}
      placeholder="label…"
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}

const edgeTypes = { arch: ArchEdge };

/** A visible mid-gray used whenever a kind color can't be resolved — never transparent. */
const MINIMAP_FALLBACK_COLOR = '#8a8a8a';

/**
 * Resolve a node's kind to a concrete minimap color. The <MiniMap> paints each silhouette
 * as an SVG <rect fill={...}>, and SVG `fill` does NOT resolve CSS custom properties (a bare
 * `var(--accent)` paints transparent), so we hand it the computed value off the live document.
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
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // A pending agent proposal for this architecture (N1), or null. Diffed against `doc`.
  const [proposalDiff, setProposalDiff] = useState<ArchDiff | null>(null);
  // Rebuilding the `nodes` prop from `doc` each render wipes React Flow's measured
  // dimensions, and the <MiniMap> skips dimensionless nodes (no silhouette). Capture
  // `dimensions` changes here and feed them back as explicit width/height.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const docRef = useRef(doc);
  docRef.current = doc;
  const rf = useReactFlow();
  const nodesReady = useNodesInitialized();

  // Fit only once nodes are measured, so fitView doesn't zoom to degenerate bounds.
  useEffect(() => {
    if (nodesReady) rf.fitView({ padding: 0.25, maxZoom: 1.2, duration: 200 });
  }, [nodesReady, rf]);

  // Load the project's architecture (or seed if none).
  useEffect(() => {
    if (projectPath) post({ type: 'requestArchitecture', path: projectPath });
    return subscribe((msg) => {
      if (msg.type === 'architecture' && (!projectPath || msg.path === projectPath)) {
        const loaded = msg.doc ?? seedArchitecture(projectName || 'System');
        setDoc(loaded);
        docRef.current = loaded;
        setGraphId(loaded.rootGraph);
        setSelectedId(null);
        setEditingEdgeId(null);
      }
      // Diff against the live doc for the banner; `null` proposed = no pending proposal.
      if (
        msg.type === 'proposal' &&
        msg.kind === 'architecture' &&
        (!projectPath || msg.path === projectPath)
      ) {
        setProposalDiff(msg.proposed ? diffArchitecture(docRef.current, msg.proposed) : null);
      }
    });
  }, [projectPath, projectName]);

  useEscapeKey(onClose);

  // Debounced save with flush on unmount — prevents data loss on quick-close.
  const { schedule: scheduleArchSave } = useDebouncedFlush(() => {
    if (projectPath) post({ type: 'updateArchitecture', path: projectPath, doc: docRef.current });
  }, 300);

  const applyDoc = useCallback(
    (updater: (d: ArchDoc) => ArchDoc) => {
      const next = updater(docRef.current);
      docRef.current = next;
      setDoc(next);
      if (projectPath) scheduleArchSave();
    },
    [projectPath, scheduleArchSave],
  );

  const drillInto = useCallback(
    (nodeId: string) => {
      const { doc: next, childGraph } = ensureChildGraph(docRef.current, graphId, nodeId);
      if (!childGraph) return;
      applyDoc(() => next);
      setSelectedId(null);
      setEditingEdgeId(null);
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
      // Re-apply the measured size so the rebuilt node keeps dimensions (else no MiniMap silhouette).
      ...(sizes[n.id] ? { width: sizes[n.id].width, height: sizes[n.id].height } : {}),
      data: {
        title: n.title,
        subtitle: n.subtitle,
        // Migrate at the render boundary so a legacy/unknown kind (old in-memory doc) still
        // hits a current KIND_VAR/KIND_ICON entry and never renders blank.
        kind: migrateKind(n.kind),
        hasChild: !!n.childGraph,
        onDrill: drillInto,
      } as ArchNodeData,
    }));
  }, [graph, selectedId, drillInto, sizes]);

  const startEdgeEdit = useCallback((edgeId: string) => setEditingEdgeId(edgeId), []);
  const cancelEdgeEdit = useCallback(() => setEditingEdgeId(null), []);
  const commitEdgeLabel = useCallback(
    (edgeId: string, label: string) => {
      applyDoc((d) => setEdgeLabel(d, graphId, edgeId, label));
      setEditingEdgeId(null);
    },
    [graphId, applyDoc],
  );

  const rfEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'arch',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        label: e.label,
        editing: e.id === editingEdgeId,
        onStartEdit: startEdgeEdit,
        onCommit: commitEdgeLabel,
        onCancel: cancelEdgeEdit,
      } as ArchEdgeData,
    }));
  }, [graph, editingEdgeId, startEdgeEdit, commitEdgeLabel, cancelEdgeEdit]);

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

  // Add a node at a flow-space top-left position; selects it. Returns the new id.
  const addComponentAt = useCallback(
    (
      flowX: number,
      flowY: number,
      partial?: { title?: string; subtitle?: string; kind?: ArchKind },
    ) => {
      let createdId = '';
      applyDoc((d) => {
        const r = addNode(d, graphId, { x: flowX, y: flowY, ...partial });
        createdId = r.id;
        return r.doc;
      });
      if (createdId) setSelectedId(createdId);
      return createdId;
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
    addComponentAt(pos.x - 90, pos.y - 30);
  }, [addComponentAt, rf]);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      setSelectedId(node.id);
      const model = graph?.nodes.find((n) => n.id === node.id);
      if (!model) return;
      setMenu({
        x: event.clientX,
        y: event.clientY,
        // Primary (open/create nested) → create (add connected) → edit (rename/duplicate) → destructive.
        items: [
          {
            label: model.childGraph ? 'Open nested canvas' : 'Create nested canvas',
            icon: <IconChevron size={13} />,
            onClick: () => drillInto(node.id),
          },
          {
            label: 'Add connected node',
            icon: <IconPlus size={13} />,
            onClick: () => {
              const newId = addComponentAt(model.x + 240, model.y);
              if (newId) applyDoc((d) => addEdge(d, graphId, node.id, newId));
            },
          },
          {
            label: 'Rename…',
            icon: <IconPencil size={13} />,
            separatorBefore: true,
            // Selecting opens the Inspector, whose Title field is the rename surface.
            onClick: () => setSelectedId(node.id),
          },
          {
            label: 'Duplicate',
            icon: <IconDuplicate size={13} />,
            onClick: () =>
              addComponentAt(model.x + 32, model.y + 32, {
                title: model.title,
                subtitle: model.subtitle,
                kind: model.kind,
              }),
          },
          {
            label: 'Delete node',
            icon: <IconTrash size={13} />,
            danger: true,
            separatorBefore: true,
            onClick: () => {
              applyDoc((d) => removeNode(d, graphId, node.id));
              setSelectedId(null);
            },
          },
        ],
      });
    },
    [graph, graphId, applyDoc, drillInto, addComponentAt],
  );

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      let pos = { x: 120, y: 120 };
      try {
        pos = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      } catch {
        /* not mounted */
      }
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            label: 'Add component here',
            icon: <IconPlus size={13} />,
            onClick: () => addComponentAt(pos.x - 90, pos.y - 30),
          },
          {
            label: 'Fit view',
            icon: <IconGraph size={13} />,
            separatorBefore: true,
            onClick: () => rf.fitView({ padding: 0.25, maxZoom: 1.2, duration: 200 }),
          },
        ],
      });
    },
    [rf, addComponentAt],
  );

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
                  setEditingEdgeId(null);
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
      </div>

      {proposalDiff && (
        <ArchProposalBanner
          diff={proposalDiff}
          onAccept={() => {
            if (projectPath)
              post({ type: 'acceptProposal', path: projectPath, kind: 'architecture' });
            setProposalDiff(null);
          }}
          onReject={() => {
            if (projectPath)
              post({ type: 'rejectProposal', path: projectPath, kind: 'architecture' });
            setProposalDiff(null);
          }}
        />
      )}

      <div className="arch__body">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onNodeDoubleClick={(_e, n) => drillInto(n.id)}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onEdgeDoubleClick={(_e, edge) => startEdgeEdit(edge.id)}
          onPaneClick={() => {
            setSelectedId(null);
            setEditingEdgeId(null);
          }}
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
            kind={migrateKind(selected.kind)}
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

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
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
        <div className="arch__kindrow">
          <span className="arch__kindicon" style={{ color: `var(${KIND_VAR[kind]})` }} aria-hidden>
            {(() => {
              const KindIcon = KIND_ICON[kind];
              return KindIcon ? <KindIcon size={14} /> : null;
            })()}
          </span>
          <select value={kind} onChange={(e) => onChange({ kind: e.target.value as ArchKind })}>
            {ARCH_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
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
