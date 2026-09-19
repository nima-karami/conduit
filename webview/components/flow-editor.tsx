import {
  BaseEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';
import type { XY } from '../../src/arch-layout';
import { layoutFlow } from '../../src/flow-layout';
import type { Rect } from '../../src/menu-position';
import {
  addEdge,
  addNode,
  addSubgraph,
  type FlowGraph,
  type FlowNode,
  type FlowShape,
  moveToSubgraph,
  nextNodeId,
  relabelEdge,
  removeEdge,
  removeNode,
  renameNode,
} from '../../src/mermaid-flow';
import { flowEdgeMenu, flowNodeMenu, flowPaneMenu } from '../plan-menu';
import { ContextMenu, type MenuState } from './context-menu';
import { Popover } from './popover';

export interface FlowEditorProps {
  graph: FlowGraph;
  onGraph(g: FlowGraph): void;
  readOnly: boolean;
  /** Wired by `PlanFlowBlock`, which owns the textarea fallback; absent here drops the row. */
  onEditAsText?: () => void;
  /** Where Esc hands focus back to; the host knows what surrounds the canvas, this does not. */
  onLeave?: () => void;
}

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Deterministic stand-in for measuring a rendered node — see the plan, Task 5.3. */
function estimateSize(n: FlowNode): { w: number; h: number } {
  return { w: 8 * n.label.length + 32, h: 40 };
}

/** The Move-to picker's "no subgraph" row; a real subgraph id can never start with '('. */
const NONE = '(none)';
const EMPTY_MOVES: Record<string, XY> = {};
const EMPTY_IDS: ReadonlySet<string> = new Set();
/** Identity sentinel: the pane menu's Edit-as-text row is dropped when nothing handles it. */
const noop = () => {};

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

interface FlowNodeData {
  label: string;
  shape: FlowShape;
  editing: boolean;
  onCommit: (id: string, label: string) => void;
  onCancel: () => void;
  [key: string]: unknown;
}

interface FlowRegionData {
  title: string;
  [key: string]: unknown;
}

interface FlowEdgeData {
  label: string | null;
  dashed: boolean;
  thick: boolean;
  editing: boolean;
  onCommit: (id: string, label: string) => void;
  onCancel: () => void;
  [key: string]: unknown;
}

function InlineInput({
  initial,
  placeholder,
  className,
  style,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  className: string;
  style?: React.CSSProperties;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className={`${className} nodrag nopan`}
      autoFocus
      value={value}
      placeholder={placeholder}
      style={style}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function FlowNodeView({ id, data, selected, sourcePosition, targetPosition }: NodeProps) {
  const d = data as FlowNodeData;
  return (
    <div
      className={`planflow__node planflow__node--${d.shape}${
        selected ? ' planflow__node--selected' : ''
      }`}
    >
      <Handle type="target" position={targetPosition ?? Position.Left} />
      {d.editing ? (
        <InlineInput
          initial={d.label}
          placeholder="label…"
          className="planflow__input"
          onCommit={(text) => d.onCommit(id, text)}
          onCancel={d.onCancel}
        />
      ) : (
        <span className="planflow__label">{d.label}</span>
      )}
      <Handle type="source" position={sourcePosition ?? Position.Right} />
    </div>
  );
}

function FlowRegionView({ data }: NodeProps) {
  const d = data as FlowRegionData;
  return (
    <div className="planflow__region">
      <div className="planflow__region-title">{d.title}</div>
    </div>
  );
}

function FlowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  markerStart,
  data,
}: EdgeProps) {
  const d = data as FlowEdgeData;
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
      <BaseEdge
        id={id}
        className="planflow__edge"
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={{
          strokeWidth: d.thick ? 3 : undefined,
          strokeDasharray: d.dashed ? '6 4' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        {d.editing ? (
          <InlineInput
            initial={d.label ?? ''}
            placeholder="label…"
            className="planflow__edge-input"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onCommit={(text) => d.onCommit(id, text)}
            onCancel={d.onCancel}
          />
        ) : (
          d.label && (
            <div
              className="planflow__edge-label nodrag nopan"
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            >
              {d.label}
            </div>
          )
        )}
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { flowNode: FlowNodeView, flowRegion: FlowRegionView };
const edgeTypes = { flowEdge: FlowEdgeView };

interface PickerOption {
  value: string;
  label: string;
}

function IdPicker({
  title,
  options,
  anchor,
  onPick,
  onClose,
}: {
  title: string;
  options: PickerOption[];
  anchor: Rect;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    frameRef.current?.focus();
  }, []);

  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      ref={frameRef}
      className="planflow__picker"
      tabIndex={-1}
      role="listbox"
      aria-label={title}
      aria-activedescendant={options[active] ? `planflow-pick-${options[active].value}` : undefined}
      onKeyDown={(e) => {
        const step = (dir: 1 | -1) => {
          e.preventDefault();
          setActive((i) => (i + dir + options.length) % options.length);
        };
        if (e.key === 'ArrowDown') step(1);
        else if (e.key === 'ArrowUp') step(-1);
        else if (e.key === 'Home') {
          e.preventDefault();
          setActive(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          setActive(options.length - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const option = options[active];
          if (option) onPick(option.value);
        }
      }}
    >
      <div className="planflow__picker-title">{title}</div>
      {options.length === 0 ? (
        <div className="planflow__picker-empty">Nothing to choose</div>
      ) : (
        options.map((o, i) => (
          <button
            key={o.value}
            id={`planflow-pick-${o.value}`}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`planflow__picker-option${
              i === active ? ' planflow__picker-option--active' : ''
            }`}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))
      )}
    </Popover>
  );
}

type Editing = { kind: 'node'; id: string } | { kind: 'edge'; index: number } | null;
type Picker = { kind: 'connect' | 'move'; nodeId: string; anchor: Rect } | null;

interface SelectionChange {
  type: 'select';
  id: string;
  selected: boolean;
}

/**
 * ReactFlow runs controlled here, so it applies nothing itself: `select` changes are the only
 * report that a click landed, and a node or edge is only `selected` — for the Delete key, which
 * deletes nothing else, and for the selected styling — because this folds them back in.
 */
function foldSelection(
  prev: ReadonlySet<string>,
  changes: readonly (NodeChange | EdgeChange)[],
): ReadonlySet<string> {
  const selections = changes.filter((c): c is SelectionChange => c.type === 'select');
  if (selections.length === 0) return prev;
  const next = new Set(prev);
  for (const s of selections) {
    if (s.selected) next.add(s.id);
    else next.delete(s.id);
  }
  return next;
}

function FlowEditorSurface({ graph, onGraph, readOnly, onEditAsText, onLeave }: FlowEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const rf = useReactFlow();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [announcement, setAnnouncement] = useState('');
  // Drag offsets are keyed to the graph they were made against, so a graph edit drops them in the
  // same render that recomputes the layout instead of a frame later (positions are never written).
  const [moves, setMoves] = useState<{ graph: FlowGraph; at: Record<string, XY> }>({
    graph,
    at: EMPTY_MOVES,
  });
  const dragged = moves.graph === graph ? moves.at : EMPTY_MOVES;
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(EMPTY_IDS);
  // An edge's id is its array index (plan, Settled decisions), so any graph edit renumbers the
  // edges: the selection is keyed to the graph it was made against rather than left to mark
  // whichever edge inherited the index.
  const [edgeSelection, setEdgeSelection] = useState<{
    graph: FlowGraph;
    ids: ReadonlySet<string>;
  }>({ graph, ids: EMPTY_IDS });
  const selectedEdges = edgeSelection.graph === graph ? edgeSelection.ids : EMPTY_IDS;

  // xyflow reports one deletion as two synchronous callbacks — the connected edges, then the node
  // — while the host writes the fence for every graph it is handed, out of a node view that only
  // re-reads its node on render: the second write would splice against a stale fence. So a tick's
  // mutations compose onto each other and leave as one.
  const pendingRef = useRef<FlowGraph | null>(null);
  const flushRef = useRef(false);
  const live = useCallback((): FlowGraph => pendingRef.current ?? graph, [graph]);

  /**
   * Takes the mutation, not its result, so composition onto a same-tick mutation is structural: a
   * caller that computed from the render's `graph` and handed the finished value over would replace
   * whatever is pending instead of building on it, and nothing in the types would say so.
   */
  const apply = useCallback(
    (mutate: (g: FlowGraph) => FlowGraph, message: string) => {
      const current = live();
      const next = mutate(current);
      if (next === current) return;
      pendingRef.current = next;
      setAnnouncement(message);
      if (flushRef.current) return;
      flushRef.current = true;
      queueMicrotask(() => {
        flushRef.current = false;
        const emitted = pendingRef.current;
        pendingRef.current = null;
        if (emitted !== null) onGraph(emitted);
      });
    },
    [live, onGraph],
  );

  // A deleted id must not come back selected when a later node is given the same one.
  useEffect(() => {
    setSelectedNodes((prev) => {
      const kept = new Set([...prev].filter((id) => graph.nodes.some((n) => n.id === id)));
      return kept.size === prev.size ? prev : kept;
    });
  }, [graph]);

  const layout = useMemo(() => layoutFlow(graph, estimateSize), [graph]);

  const vertical = graph.direction === 'TB' || graph.direction === 'TD' || graph.direction === 'BT';
  const mirrored = graph.direction === 'BT' || graph.direction === 'RL';
  const sourcePosition = vertical
    ? mirrored
      ? Position.Top
      : Position.Bottom
    : mirrored
      ? Position.Left
      : Position.Right;
  const targetPosition = vertical
    ? mirrored
      ? Position.Bottom
      : Position.Top
    : mirrored
      ? Position.Right
      : Position.Left;

  const commitNodeName = useCallback(
    (id: string, label: string) => {
      setEditing(null);
      apply((g) => renameNode(g, id, label.trim() || id), `Renamed ${id}`);
    },
    [apply],
  );

  const commitEdgeLabel = useCallback(
    (id: string, label: string) => {
      setEditing(null);
      const index = Number(id.slice(1));
      const e = graph.edges[index];
      if (!e) return;
      apply((g) => relabelEdge(g, index, label), `Relabelled edge ${e.source} to ${e.target}`);
    },
    [graph, apply],
  );

  const cancelEditing = useCallback(() => setEditing(null), []);

  const rfNodes = useMemo(() => {
    // xyflow reads `parentId` against the nodes already in the array, so every region has to
    // precede its members; `graph.subgraphs` is canonically depth-first, which is that order.
    const out: Node[] = [];
    const relative = (x: number, y: number, parent: string | null): XY => {
      const box = parent ? layout.regions[parent] : undefined;
      return box ? { x: x - box.x, y: y - box.y } : { x, y };
    };
    for (const s of graph.subgraphs) {
      const r = layout.regions[s.id];
      if (!r) continue;
      const nested = s.parent && layout.regions[s.parent] ? { parentId: s.parent } : {};
      out.push({
        id: s.id,
        type: 'flowRegion',
        position: relative(r.x, r.y, s.parent),
        width: r.w,
        height: r.h,
        style: { width: r.w, height: r.h },
        data: { title: s.title } satisfies FlowRegionData,
        draggable: false,
        connectable: false,
        deletable: false,
        selectable: false,
        domAttributes: { 'aria-roledescription': 'subgraph' },
        ...nested,
        ...(nested.parentId ? { extent: 'parent' as const } : {}),
      });
    }
    for (const n of graph.nodes) {
      const p = layout.positions[n.id];
      if (!p) continue;
      const size = estimateSize(n);
      const nested = n.parent && layout.regions[n.parent] ? { parentId: n.parent } : {};
      out.push({
        id: n.id,
        type: 'flowNode',
        position: dragged[n.id] ?? relative(p.x, p.y, n.parent),
        width: size.w,
        height: size.h,
        sourcePosition,
        targetPosition,
        draggable: !readOnly,
        connectable: !readOnly,
        deletable: !readOnly,
        selected: selectedNodes.has(n.id),
        domAttributes: { 'aria-roledescription': 'node' },
        data: {
          label: n.label,
          shape: n.shape,
          editing: editing?.kind === 'node' && editing.id === n.id,
          onCommit: commitNodeName,
          onCancel: cancelEditing,
        } satisfies FlowNodeData,
        ...nested,
        ...(nested.parentId ? { extent: 'parent' as const } : {}),
      });
    }
    return out;
  }, [
    graph,
    layout,
    dragged,
    editing,
    readOnly,
    selectedNodes,
    sourcePosition,
    targetPosition,
    commitNodeName,
    cancelEditing,
  ]);

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e, i) => ({
        id: `e${i}`,
        source: e.source,
        target: e.target,
        type: 'flowEdge',
        deletable: !readOnly,
        selected: selectedEdges.has(`e${i}`),
        markerEnd: e.kind === 'open' ? undefined : { type: MarkerType.ArrowClosed },
        markerStart: e.kind === 'bidir' ? { type: MarkerType.ArrowClosed } : undefined,
        domAttributes: { 'aria-roledescription': 'edge' },
        data: {
          label: e.label,
          dashed: e.kind === 'dotted',
          thick: e.kind === 'thick',
          editing: editing?.kind === 'edge' && editing.index === i,
          onCommit: commitEdgeLabel,
          onCancel: cancelEditing,
        } satisfies FlowEdgeData,
      })),
    [graph, editing, readOnly, selectedEdges, commitEdgeLabel, cancelEditing],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setSelectedNodes((prev) => foldSelection(prev, changes));

      const dragTo: Record<string, XY> = {};
      let moved = false;
      for (const c of changes) {
        if (c.type !== 'position' || !c.position) continue;
        dragTo[c.id] = c.position;
        moved = true;
      }
      if (moved)
        setMoves((prev) => ({
          graph,
          at: { ...(prev.graph === graph ? prev.at : EMPTY_MOVES), ...dragTo },
        }));

      if (readOnly) return;
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (!removed.length) return;
      apply(
        (g) => {
          let next = g;
          for (const id of removed) next = removeNode(next, id);
          return next;
        },
        `Removed node ${removed.join(', ')}`,
      );
    },
    [graph, readOnly, apply],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdgeSelection((prev) => {
        const base = prev.graph === graph ? prev.ids : EMPTY_IDS;
        const ids = foldSelection(base, changes);
        return ids === base && prev.graph === graph ? prev : { graph, ids };
      });

      if (readOnly) return;
      // Edge identity is the array index, so removals are applied high-to-low: the other order
      // would shift every index still to be removed.
      const indices = changes
        .filter((c) => c.type === 'remove')
        .map((c) => Number(c.id.slice(1)))
        .filter((i) => Number.isInteger(i) && graph.edges[i])
        .sort((a, b) => b - a);
      if (!indices.length) return;
      const said = indices.map((i) => `${graph.edges[i].source} to ${graph.edges[i].target}`);
      apply(
        (g) => {
          let next = g;
          for (const i of indices) next = removeEdge(next, i);
          return next;
        },
        `Removed edge ${said.join(', ')}`,
      );
    },
    [graph, readOnly, apply],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (readOnly || !c.source || !c.target) return;
      apply((g) => addEdge(g, c.source, c.target), `Connected ${c.source} to ${c.target}`);
    },
    [readOnly, apply],
  );

  const connectOptions = useCallback(
    (nodeId: string): PickerOption[] =>
      graph.nodes
        .filter((n) => n.id !== nodeId)
        .map((n) => ({ value: n.id, label: n.label === n.id ? n.id : `${n.label} (${n.id})` })),
    [graph],
  );

  const moveOptions = useCallback(
    (): PickerOption[] => [
      { value: NONE, label: NONE },
      ...graph.subgraphs.map((s) => ({ value: s.id, label: s.title })),
    ],
    [graph],
  );

  const closePicker = useCallback(() => {
    setPicker(null);
    returnFocusRef.current?.focus();
  }, []);

  const onPick = useCallback(
    (value: string) => {
      if (!picker) return;
      closePicker();
      if (picker.kind === 'connect') {
        apply((g) => addEdge(g, picker.nodeId, value), `Connected ${picker.nodeId} to ${value}`);
        return;
      }
      const to = value === NONE ? null : value;
      const title = to === null ? NONE : (graph.subgraphs.find((s) => s.id === to)?.title ?? to);
      apply((g) => moveToSubgraph(g, picker.nodeId, to), `Moved ${picker.nodeId} to ${title}`);
    },
    [picker, graph, apply, closePicker],
  );

  const openPicker = useCallback((kind: 'connect' | 'move', nodeId: string, anchor: Rect) => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setPicker({ kind, nodeId, anchor });
  }, []);

  const pickerAnchorFor = useCallback((nodeId: string): Rect | null => {
    const el = rootRef.current?.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
    return el ? rectOf(el) : null;
  }, []);

  const addFlowNode = useCallback(() => {
    const id = nextNodeId(graph, 'n');
    apply((g) => addNode(g, id, id), `Added node ${id}`);
  }, [graph, apply]);

  const addFlowSubgraph = useCallback(() => {
    const id = nextNodeId(graph, 'group');
    apply((g) => addSubgraph(g, id, 'Group'), `Added subgraph ${id}`);
  }, [graph, apply]);

  const fit = useCallback(
    () => rf.fitView({ padding: 0.1, maxZoom: 1.2, duration: prefersReducedMotion() ? 0 : 200 }),
    [rf],
  );

  // ReactFlow's `fitView` prop runs once, at init — and inside a ProseMirror node view the canvas
  // has no size yet then, so the fit clamps to minZoom and parks the graph outside the canvas: a
  // blank diagram whose nodes are still in the DOM, which is why no count-based test sees it.
  // Re-fit until one succeeds; after that the viewport is the user's (drag, zoom, the Fit button).
  const fittedRef = useRef(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (fittedRef.current || !el.clientWidth || !el.clientHeight) return;
      void rf.fitView({ padding: 0.1, maxZoom: 1.2 }).then((ok) => {
        fittedRef.current = ok;
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [rf]);

  const openNodeMenu = useCallback(
    (x: number, y: number, id: string, keyboard?: boolean, anchor?: Rect) => {
      if (readOnly) return;
      setMenu({
        x,
        y,
        keyboard,
        anchor,
        items: flowNodeMenu({
          onRename: () => setEditing({ kind: 'node', id }),
          onConnect: () => {
            const at = anchor ?? pickerAnchorFor(id);
            if (at) openPicker('connect', id, at);
          },
          onMoveTo: () => {
            const at = anchor ?? pickerAnchorFor(id);
            if (at) openPicker('move', id, at);
          },
          onDelete: () => apply((g) => removeNode(g, id), `Removed node ${id}`),
        }),
      });
    },
    [readOnly, apply, openPicker, pickerAnchorFor],
  );

  const openEdgeMenu = useCallback(
    (x: number, y: number, id: string, keyboard?: boolean, anchor?: Rect) => {
      if (readOnly) return;
      const index = Number(id.slice(1));
      const e = graph.edges[index];
      if (!e) return;
      setMenu({
        x,
        y,
        keyboard,
        anchor,
        items: flowEdgeMenu({
          onRelabel: () => setEditing({ kind: 'edge', index }),
          onDelete: () =>
            apply((g) => removeEdge(g, index), `Removed edge ${e.source} to ${e.target}`),
        }),
      });
    },
    [readOnly, graph, apply],
  );

  const openPaneMenu = useCallback(
    (x: number, y: number, keyboard?: boolean) => {
      const items = flowPaneMenu({
        onAddNode: addFlowNode,
        onAddSubgraph: addFlowSubgraph,
        onFit: fit,
        onEditAsText: onEditAsText ?? noop,
      });
      // Neither Fit nor Edit as text mutates the graph, so read-only keeps them; the rest go.
      const shown = items.filter(
        (i) => i.onClick !== noop && (!readOnly || i.onClick === fit || i.onClick === onEditAsText),
      );
      if (!shown.length) return;
      // A separator is a rule BETWEEN groups, and Fit declares one: read-only drops every row above
      // it, leaving the rule painted against the top edge of the menu.
      const rows = shown[0].separatorBefore
        ? [{ ...shown[0], separatorBefore: false }, ...shown.slice(1)]
        : shown;
      setMenu({ x, y, keyboard, items: rows });
    },
    [readOnly, addFlowNode, addFlowSubgraph, fit, onEditAsText],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  // Shift+F10 / the ContextMenu key, scoped to this editor's root (the app has several canvases).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      const root = rootRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (!root || !active || !root.contains(active)) return;
      const nodeEl = active.closest('.react-flow__node[data-id]');
      const edgeEl = active.closest('.react-flow__edge[data-id]');
      e.preventDefault();
      e.stopPropagation();
      const nodeId = nodeEl?.getAttribute('data-id');
      const edgeId = edgeEl?.getAttribute('data-id');
      if (nodeEl && nodeId) {
        const r = rectOf(nodeEl);
        openNodeMenu(r.left + 12, r.bottom - 8, nodeId, true, r);
      } else if (edgeEl && edgeId) {
        const r = rectOf(edgeEl);
        openEdgeMenu((r.left + r.right) / 2, (r.top + r.bottom) / 2, edgeId, true, r);
      } else {
        const r = root.getBoundingClientRect();
        openPaneMenu(r.left + r.width / 2, r.top + r.height / 2, true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openNodeMenu, openEdgeMenu, openPaneMenu]);

  // The non-drag pathways for connect and group (spec §10, WCAG 2.5.7), plus Enter to edit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (readOnly || !root || !active || !root.contains(active)) return;
      if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') return;
      const nodeEl = active.closest('.react-flow__node[data-id]');
      const nodeId = nodeEl?.getAttribute('data-id') ?? null;
      const key = e.key.toLowerCase();
      if (e.shiftKey && (key === 'c' || key === 'g')) {
        if (!nodeId || !graph.nodes.some((n) => n.id === nodeId)) return;
        e.preventDefault();
        e.stopPropagation();
        openPicker(key === 'c' ? 'connect' : 'move', nodeId, rectOf(nodeEl as Element));
        return;
      }
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (nodeId && graph.nodes.some((n) => n.id === nodeId)) {
        e.preventDefault();
        setEditing({ kind: 'node', id: nodeId });
        return;
      }
      const edgeId = active.closest('.react-flow__edge[data-id]')?.getAttribute('data-id');
      const index = edgeId ? Number(edgeId.slice(1)) : Number.NaN;
      if (graph.edges[index]) {
        e.preventDefault();
        setEditing({ kind: 'edge', index });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [readOnly, graph, openPicker]);

  // Spec §10: Esc leaves the diagram in one keystroke, wherever inside it focus happens to be.
  // Read-only is no exception — the canvas is still navigable there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || menu !== null || picker !== null || editing !== null) return;
      const root = rootRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (!root || !active || !root.contains(active)) return;
      e.preventDefault();
      e.stopPropagation();
      active.blur();
      onLeave?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menu, picker, editing, onLeave]);

  const pickerOptions = picker
    ? picker.kind === 'connect'
      ? connectOptions(picker.nodeId)
      : moveOptions()
    : [];

  return (
    <div className="planflow__canvas" ref={rootRef}>
      {/* Read-only drops the buttons that edit the graph, never Fit or Edit as text: neither
          changes the diagram, and they are how a locked plan is read at all. */}
      <div className="planflow__toolbar">
        {!readOnly && (
          <>
            <button type="button" className="planflow__button" onClick={addFlowNode}>
              Add node
            </button>
            <button type="button" className="planflow__button" onClick={addFlowSubgraph}>
              Add subgraph
            </button>
          </>
        )}
        <button type="button" className="planflow__button" onClick={fit}>
          Fit
        </button>
        {onEditAsText && (
          <button type="button" className="planflow__button" onClick={onEditAsText}>
            Edit as text
          </button>
        )}
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDoubleClick={(_e, n) => {
          if (!readOnly && n.type === 'flowNode') setEditing({ kind: 'node', id: n.id });
        }}
        onEdgeDoubleClick={(_e, edge) => {
          const index = Number(edge.id.slice(1));
          if (!readOnly && graph.edges[index]) setEditing({ kind: 'edge', index });
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          if (n.type === 'flowNode') openNodeMenu(e.clientX, e.clientY, n.id);
          else openPaneMenu(e.clientX, e.clientY);
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          openEdgeMenu(e.clientX, e.clientY, edge.id);
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          openPaneMenu('clientX' in e ? e.clientX : 0, 'clientY' in e ? e.clientY : 0);
        }}
        onPaneClick={() => setEditing(null)}
        fitView
        fitViewOptions={{ padding: 0.1, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2}
      />
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {picker && (
        <IdPicker
          title={picker.kind === 'connect' ? 'Connect to…' : 'Move to subgraph…'}
          options={pickerOptions}
          anchor={picker.anchor}
          onPick={onPick}
          onClose={closePicker}
        />
      )}
      <div className="planflow__live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

export function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorSurface {...props} />
    </ReactFlowProvider>
  );
}
