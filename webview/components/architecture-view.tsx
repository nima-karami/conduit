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
  useStore,
  useUpdateNodeInternals,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDebouncedFlush } from '../use-debounced-flush';
import '@xyflow/react/dist/style.css';
import {
  type History,
  initHistory,
  push as pushHistory,
  redo as redoHistory,
  undo as undoHistory,
} from '../../src/arch-history';
import { applyAutoLayout, autoLayoutUnpositioned } from '../../src/arch-layout';
import {
  ARCH_KINDS,
  type ArchDoc,
  type ArchKind,
  type ArchNode,
  addEdge,
  addGroup,
  addInterface,
  addInterfaceField,
  addNode,
  addPort,
  addTypedEdge,
  breadcrumb,
  encapsulateSelection,
  ensureChildGraph,
  explodeComponent,
  formatTypeRef,
  getGraph,
  type InterfaceDef,
  type InterfaceField,
  insertSpace,
  interfaceUsage,
  migrateKind,
  moveInterfaceField,
  type Port,
  type PortDirection,
  type PrimitiveName,
  parentOf,
  removeEdge,
  removeGroup,
  removeInterface,
  removeInterfaceField,
  removeNode,
  removePort,
  renameGroup,
  renameInterface,
  renamePort,
  seedArchitecture,
  setEdgeLabel,
  setPortType,
  type TypeRef,
  ungroup,
  updateInterfaceField,
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
import { ConfirmDialog, type ConfirmState } from './confirm-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { ArchProposalBanner } from './proposal-banner';

const PRIMITIVE_NAMES: PrimitiveName[] = ['string', 'number', 'boolean', 'date', 'json', 'any'];

/** Plural-aware "Used by N" copy (avoids "1 references"). */
function usedByLabel(n: number): string {
  return `Used by ${n} ${n === 1 ? 'reference' : 'references'}`;
}

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

/** Resolve each of a node's ports to its display type label (skips untyped ports). */
function portTypeLabels(
  n: ArchNode,
  interfaces?: Record<string, InterfaceDef>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of [...(n.inputs ?? []), ...(n.outputs ?? [])]) {
    const label = formatTypeRef(p.type, interfaces);
    if (label) out[p.id] = label;
  }
  return out;
}

interface ArchNodeData {
  title: string;
  subtitle?: string;
  kind: ArchKind;
  hasChild: boolean;
  icon?: string;
  empty?: boolean;
  inputs?: Port[];
  outputs?: Port[];
  typeLabels?: Record<string, string>; // portId → formatted type (resolved against interfaces)
  editingPortId?: string | null;
  editingTitle?: boolean;
  onDrill: (id: string) => void;
  onAddPort: (nodeId: string, dir: PortDirection) => void;
  onRemovePort: (nodeId: string, portId: string) => void;
  onStartPortEdit: (portId: string) => void;
  onCommitPortName: (nodeId: string, portId: string, name: string) => void;
  onCancelPortEdit: () => void;
  onStartTitleEdit: (nodeId: string) => void;
  onCommitTitle: (nodeId: string, title: string) => void;
  onCancelTitleEdit: () => void;
  onPortContextMenu: (e: React.MouseEvent, nodeId: string, portId: string) => void;
  [key: string]: unknown;
}

/** Zoom at/above which port labels + edit widgets are revealed (the Grasshopper ZUI, spec A). */
const PORT_REVEAL_ZOOM = 0.85;

/** One port pin: a React Flow handle + its (editable) name/type label. Handles render in normal
 *  flow (position:relative via CSS) so multiple stack down the card edge. */
function PortPin({
  nodeId,
  port,
  dir,
  typeLabel,
  editing,
  onRemove,
  onStartEdit,
  onCommit,
  onCancel,
  onContextMenu,
}: {
  nodeId: string;
  port: Port;
  dir: PortDirection;
  typeLabel: string;
  editing: boolean;
  onRemove: (nodeId: string, portId: string) => void;
  onStartEdit: (portId: string) => void;
  onCommit: (nodeId: string, portId: string, name: string) => void;
  onCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [value, setValue] = useState(port.name);
  const handle = (
    <Handle
      type={dir === 'in' ? 'target' : 'source'}
      position={dir === 'in' ? Position.Left : Position.Right}
      id={port.id}
      className="archnode__pin"
    />
  );
  const label = editing ? (
    <input
      className="archport__input nodrag nopan"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onCommit(nodeId, port.id, value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(nodeId, port.id, value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  ) : (
    <span
      className="archport__name"
      title="Double-click to rename"
      onDoubleClick={(e) => {
        e.stopPropagation();
        setValue(port.name);
        onStartEdit(port.id);
      }}
    >
      {port.name}
      {typeLabel && <span className="archport__type">: {typeLabel}</span>}
    </span>
  );
  return (
    <div
      className={`archport archport--${dir}`}
      data-port-name={port.name}
      onContextMenu={onContextMenu}
    >
      {dir === 'in' && handle}
      {label}
      <button
        type="button"
        className="archport__rm nodrag"
        title="Remove port"
        aria-label={`Remove ${dir === 'in' ? 'input' : 'output'} ${port.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(nodeId, port.id);
        }}
      >
        ×
      </button>
      {dir === 'out' && handle}
    </div>
  );
}

/** In-place component title editor (spec A): Enter/blur commits, Esc cancels, empty reverts. */
function TitleInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="archnode__titleinput nodrag nopan"
      aria-label="Component name"
      autoFocus
      value={value}
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

/** Custom React Flow node: a component card with a kind stripe, named ports, and drill-in. */
function ArchNodeCard({ id, data, selected }: NodeProps) {
  const d = data as ArchNodeData;
  // A chosen icon overrides the kind default (spec A); both come from the shared glyph set.
  const KindIcon = (d.icon && KIND_ICON[d.icon as ArchKind]) || KIND_ICON[d.kind];
  const inputs = d.inputs ?? [];
  const outputs = d.outputs ?? [];
  const hasPorts = inputs.length > 0 || outputs.length > 0;
  const labels = d.typeLabels ?? {};
  // ZUI reveal (spec A): show pin labels + edit widgets when zoomed in or the node is selected.
  const zoom = useStore((s) => s.transform[2]);
  const revealed = zoom >= PORT_REVEAL_ZOOM || selected;
  // Revealing/collapsing resizes the card and shifts the in-flow port handles. React Flow caches
  // handle positions, so without this its edges would route to stale spots (or vanish) until the
  // next full remeasure — re-measure explicitly whenever the reveal state or port count changes.
  const updateNodeInternals = useUpdateNodeInternals();
  // biome-ignore lint/correctness/useExhaustiveDependencies: revealed + port counts are intentional re-measure triggers, not values read in the body
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, revealed, inputs.length, outputs.length, updateNodeInternals]);
  const pin = (port: Port, dir: PortDirection) => (
    <PortPin
      key={port.id}
      nodeId={id}
      port={port}
      dir={dir}
      typeLabel={labels[port.id] ?? ''}
      editing={d.editingPortId === port.id}
      onRemove={d.onRemovePort}
      onStartEdit={d.onStartPortEdit}
      onCommit={d.onCommitPortName}
      onCancel={d.onCancelPortEdit}
      onContextMenu={(e) => d.onPortContextMenu(e, id, port.id)}
    />
  );
  return (
    <div
      className={`archnode archnode--${d.kind}${selected ? ' archnode--sel' : ''}${d.hasChild ? ' archnode--complex' : ''}${d.empty ? ' archnode--empty' : ''}${revealed ? '' : ' archnode--collapsed'}`}
    >
      <span className="archnode__stripe" style={{ background: `var(${KIND_VAR[d.kind]})` }} />
      {/* Legacy whole-node handles only when the node declares no ports (back-compat). */}
      {!hasPorts && <Handle type="target" position={Position.Left} className="archnode__handle" />}
      <div className="archnode__head">
        <span className="archnode__icon" style={{ color: `var(${KIND_VAR[d.kind]})` }} aria-hidden>
          {KindIcon && <KindIcon size={15} />}
        </span>
        <div className="archnode__body">
          {d.editingTitle ? (
            <TitleInput
              initial={d.title}
              onCommit={(t) => d.onCommitTitle(id, t)}
              onCancel={d.onCancelTitleEdit}
            />
          ) : (
            <div
              className="archnode__title"
              title="Double-click to rename"
              onDoubleClick={(e) => {
                e.stopPropagation();
                d.onStartTitleEdit(id);
              }}
            >
              {d.title}
            </div>
          )}
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
      </div>
      <div className="archnode__ports">
        <div className="archnode__col archnode__col--in">
          {inputs.map((p) => pin(p, 'in'))}
          <button
            type="button"
            className="archport__add nodrag"
            onClick={(e) => {
              e.stopPropagation();
              d.onAddPort(id, 'in');
            }}
          >
            <IconPlus size={10} /> in
          </button>
        </div>
        <div className="archnode__col archnode__col--out">
          {outputs.map((p) => pin(p, 'out'))}
          <button
            type="button"
            className="archport__add nodrag"
            onClick={(e) => {
              e.stopPropagation();
              d.onAddPort(id, 'out');
            }}
          >
            <IconPlus size={10} /> out
          </button>
        </div>
      </div>
      {!hasPorts && <Handle type="source" position={Position.Right} className="archnode__handle" />}
    </div>
  );
}

interface BoundaryData {
  dir: PortDirection;
  title: string;
  ports: Port[];
  onPortContextMenu: (e: React.MouseEvent, portId: string) => void;
  [key: string]: unknown;
}

/** Read-only interface node inside a child graph: surfaces the parent component's declared ports
 *  (spec F boundary convention). `boundary:in` exposes parent inputs as sources; `boundary:out`
 *  consumes parent outputs as targets. Not editable here — the contract is owned by the parent. */
function BoundaryNode({ data }: NodeProps) {
  const d = data as BoundaryData;
  const isIn = d.dir === 'in';
  return (
    <div className={`archboundary archboundary--${d.dir}`}>
      <div className="archboundary__title">{d.title}</div>
      <div className="archboundary__ports">
        {d.ports.map((p) => (
          <div
            className={`archport archport--${isIn ? 'out' : 'in'}`}
            key={p.id}
            onContextMenu={(e) => d.onPortContextMenu(e, p.id)}
          >
            {!isIn && (
              <Handle type="target" position={Position.Left} id={p.id} className="archnode__pin" />
            )}
            <span className="archport__name">{p.name}</span>
            {isIn && (
              <Handle type="source" position={Position.Right} id={p.id} className="archnode__pin" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface GroupData {
  label: string;
  editing: boolean;
  groupId: string;
  onStartEdit: (groupId: string) => void;
  onCommit: (groupId: string, label: string) => void;
  onCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  [key: string]: unknown;
}

/** A named cluster box (spec D) rendered behind its members; label edits in place. The box size +
 *  position are computed from member bounds in <Canvas>, so this only paints chrome + the label. */
function GroupBox({ data }: NodeProps) {
  const d = data as GroupData;
  return (
    <div
      className="archgroup"
      onContextMenu={(e) => {
        e.stopPropagation();
        e.preventDefault();
        d.onContextMenu(e);
      }}
    >
      {d.editing ? (
        <div className="archgroup__label">
          <TitleInput
            initial={d.label}
            onCommit={(t) => d.onCommit(d.groupId, t)}
            onCancel={d.onCancel}
          />
        </div>
      ) : (
        <div
          className="archgroup__label"
          title="Double-click to rename"
          onDoubleClick={(e) => {
            e.stopPropagation();
            d.onStartEdit(d.groupId);
          }}
        >
          {d.label}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { arch: ArchNodeCard, archBoundary: BoundaryNode, archGroup: GroupBox };

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

/** The interface id a type ref ultimately points at (through list wrappers), or null. */
function refTargetId(t: TypeRef | undefined): string | null {
  if (!t) return null;
  if (t.kind === 'ref') return t.interfaceId;
  if (t.kind === 'list') return refTargetId(t.of);
  return null;
}

/**
 * Shared type picker popover (spec E §2.5): composes one `TypeRef` — Untyped (ports only), a
 * primitive, `List<…>` (a nestable wrap toggle), or a ref to an interface (searchable, with inline
 * "New interface…" creation). Esc closes; the search box filters the interface registry.
 */
function TypePicker({
  allowUntyped,
  interfaces,
  onPick,
  onNewInterface,
  onClose,
}: {
  allowUntyped: boolean;
  interfaces: Record<string, InterfaceDef>;
  onPick: (type: TypeRef | undefined) => void;
  onNewInterface: (name: string | undefined) => string;
  onClose: () => void;
}) {
  const [depth, setDepth] = useState(0); // number of List<> wrappers around the chosen element
  const [query, setQuery] = useState('');
  const commit = (t: TypeRef | undefined) => {
    if (t === undefined) onPick(undefined);
    else {
      let wrapped = t;
      for (let i = 0; i < depth; i++) wrapped = { kind: 'list', of: wrapped };
      onPick(wrapped);
    }
    onClose();
  };
  const q = query.trim();
  const ifaceList = Object.values(interfaces).filter((i) =>
    i.name.toLowerCase().includes(q.toLowerCase()),
  );
  const noMatch = q.length > 0 && ifaceList.length === 0;

  return (
    <div
      className="typepicker nodrag nopan"
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {depth > 0 && (
        <div className="typepicker__hint">
          {'List<'.repeat(depth)}…{'>'.repeat(depth)} — pick element
        </div>
      )}
      <div className="typepicker__row">
        {allowUntyped && depth === 0 && (
          <button
            type="button"
            className="typepicker__opt"
            role="menuitem"
            onClick={() => commit(undefined)}
          >
            Untyped
          </button>
        )}
        <button
          type="button"
          className={`typepicker__opt${depth > 0 ? ' typepicker__opt--active' : ''}`}
          role="menuitem"
          title="Wrap the chosen element in a List<>"
          onClick={() => setDepth((d) => d + 1)}
        >
          List of…
        </button>
        {depth > 0 && (
          <button
            type="button"
            className="typepicker__opt"
            role="menuitem"
            onClick={() => setDepth((d) => Math.max(0, d - 1))}
          >
            ← unwrap
          </button>
        )}
      </div>
      <div className="typepicker__prims">
        {PRIMITIVE_NAMES.map((p) => (
          <button
            key={p}
            type="button"
            className="typepicker__opt"
            role="menuitem"
            onClick={() => commit({ kind: 'primitive', name: p })}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="typepicker__ifaces">
        <input
          className="typepicker__search nodrag nopan"
          autoFocus
          placeholder="Interface…"
          aria-label="Filter interfaces"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="typepicker__list">
          {ifaceList.map((i) => (
            <button
              key={i.id}
              type="button"
              className="typepicker__opt"
              role="menuitem"
              onClick={() => commit({ kind: 'ref', interfaceId: i.id })}
            >
              {i.name}
            </button>
          ))}
          {noMatch && (
            <button
              type="button"
              className="typepicker__opt typepicker__opt--new"
              role="menuitem"
              onClick={() => commit({ kind: 'ref', interfaceId: onNewInterface(q) })}
            >
              Create “{q}”
            </button>
          )}
          <button
            type="button"
            className="typepicker__opt typepicker__opt--new"
            role="menuitem"
            onClick={() => commit({ kind: 'ref', interfaceId: onNewInterface(undefined) })}
          >
            + New interface…
          </button>
        </div>
      </div>
    </div>
  );
}

/** A type label rendered as a button that opens a {@link TypePicker} popover. Serves both a port's
 *  type (untyped allowed) and an interface field's type (must be typed → `any` is the fallback). */
function TypeChip({
  type,
  interfaces,
  allowUntyped,
  ariaLabel,
  onPick,
  onNewInterface,
}: {
  type: TypeRef | undefined;
  interfaces: Record<string, InterfaceDef>;
  allowUntyped: boolean;
  ariaLabel: string;
  onPick: (t: TypeRef | undefined) => void;
  onNewInterface: (name: string | undefined) => string;
}) {
  const [open, setOpen] = useState(false);
  const label = formatTypeRef(type, interfaces) || (allowUntyped ? 'untyped' : 'any');
  return (
    <span className="typechip__wrap">
      <button
        type="button"
        className={`typechip${type ? '' : ' typechip--untyped'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {label}
      </button>
      {open && (
        <TypePicker
          allowUntyped={allowUntyped}
          interfaces={interfaces}
          onPick={onPick}
          onNewInterface={onNewInterface}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

/** Focusable label that turns into an input on click/Enter; Enter/blur commits, Esc reverts. */
function InlineName({
  value,
  ariaLabel,
  className,
  onCommit,
}: {
  value: string;
  ariaLabel: string;
  className: string;
  onCommit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  if (!editing) {
    return (
      <button
        type="button"
        className={`${className} inlinename`}
        title="Rename"
        onClick={() => {
          setText(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }
  return (
    <input
      className={`${className} inlinename__input`}
      aria-label={ariaLabel}
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        onCommit(text);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(text);
          setEditing(false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setEditing(false);
        }
      }}
    />
  );
}

interface FieldOps {
  onRename: (index: number, name: string) => void;
  onSetType: (index: number, type: TypeRef | undefined) => void;
  onToggleOptional: (index: number, optional: boolean) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}

/** One editable field row inside the interface detail (name · type chip · optional · reorder · remove). */
function FieldRow({
  field,
  index,
  count,
  interfaces,
  ops,
  onNavigate,
  onNewInterface,
}: {
  field: InterfaceField;
  index: number;
  count: number;
  interfaces: Record<string, InterfaceDef>;
  ops: FieldOps;
  onNavigate: (interfaceId: string) => void;
  onNewInterface: (name: string | undefined) => string;
}) {
  const target = refTargetId(field.type);
  return (
    <li className="ifacefield">
      <InlineName
        className="ifacefield__name"
        ariaLabel="Field name"
        value={field.name}
        onCommit={(t) => ops.onRename(index, t)}
      />
      <TypeChip
        type={field.type}
        interfaces={interfaces}
        allowUntyped={false}
        ariaLabel={`Type of ${field.name}`}
        onPick={(t) => ops.onSetType(index, t)}
        onNewInterface={onNewInterface}
      />
      {target && interfaces[target] && (
        <button
          type="button"
          className="ifacefield__goto"
          title="Open definition"
          aria-label={`Open definition of ${interfaces[target].name}`}
          onClick={() => onNavigate(target)}
        >
          ↗
        </button>
      )}
      <label className="ifacefield__opt" title="Optional field">
        <input
          type="checkbox"
          checked={field.optional === true}
          onChange={(e) => ops.onToggleOptional(index, e.target.checked)}
        />
        <span>optional</span>
      </label>
      <span className="ifacefield__reorder">
        <button
          type="button"
          className="ifacefield__mv"
          title="Move up"
          aria-label={`Move ${field.name} up`}
          disabled={index === 0}
          onClick={() => ops.onMove(index, index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="ifacefield__mv"
          title="Move down"
          aria-label={`Move ${field.name} down`}
          disabled={index === count - 1}
          onClick={() => ops.onMove(index, index + 1)}
        >
          ↓
        </button>
      </span>
      <button
        type="button"
        className="ifacefield__rm"
        title="Remove field"
        aria-label={`Remove field ${field.name}`}
        onClick={() => ops.onRemove(index)}
      >
        ×
      </button>
    </li>
  );
}

/** Document-scoped interface authoring surface (spec E): master list + selected-interface detail. */
function InterfacesPanel({
  doc,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onAddField,
  fieldOps,
  onNewInterface,
  onClose,
}: {
  doc: ArchDoc;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string | undefined) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddField: (id: string) => void;
  fieldOps: (id: string) => FieldOps;
  onNewInterface: (name: string | undefined) => string;
  onClose: () => void;
}) {
  const interfaces = doc.interfaces ?? {};
  const list = Object.values(interfaces);
  const usage = useMemo(() => interfaceUsage(doc), [doc]);
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const filtered = f ? list.filter((i) => i.name.toLowerCase().includes(f)) : list;
  const selected = selectedId ? interfaces[selectedId] : undefined;

  return (
    <aside className="arch__interfaces" aria-label="Interfaces">
      <div className="arch__insphead">
        Interfaces
        <button
          type="button"
          className="arch__panelclose"
          title="Close"
          aria-label="Close interfaces panel"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="ifaces__toolbar">
        <input
          className="ifaces__filter"
          placeholder="Filter…"
          aria-label="Filter interfaces"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn ifaces__new" onClick={() => onCreate(undefined)}>
          <IconPlus size={12} /> New
        </button>
      </div>
      {list.length === 0 ? (
        <div className="ifaces__blank">
          No interfaces yet. Create one to give ports a structured type.
        </div>
      ) : (
        <ul className="ifaces__list">
          {filtered.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className={`ifaces__row${i.id === selectedId ? ' ifaces__row--sel' : ''}`}
                aria-selected={i.id === selectedId}
                onClick={() => onSelect(i.id)}
              >
                <span className="ifaces__rowname">{i.name}</span>
                <span className="ifaces__rowmeta">
                  {i.fields.length} {i.fields.length === 1 ? 'field' : 'fields'} ·{' '}
                  {usedByLabel(usage[i.id] ?? 0)}
                </span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="ifaces__nomatch">
              No interface matches “{filter.trim()}”.{' '}
              <button
                type="button"
                className="ifaces__createq"
                onClick={() => onCreate(filter.trim())}
              >
                Create “{filter.trim()}”
              </button>
            </li>
          )}
        </ul>
      )}

      {selected && (
        <div className="ifacedetail">
          <div className="ifacedetail__head">
            <InlineName
              className="ifacedetail__name"
              ariaLabel="Interface name"
              value={selected.name}
              onCommit={(t) => onRename(selected.id, t)}
            />
            <button
              type="button"
              className="ifacedetail__del"
              title="Delete interface"
              aria-label={`Delete interface ${selected.name}`}
              onClick={() => onDelete(selected.id)}
            >
              <IconTrash size={13} />
            </button>
          </div>
          <div className="ifacedetail__meta">{usedByLabel(usage[selected.id] ?? 0)}</div>
          {selected.fields.length === 0 ? (
            <div className="ifaces__blank">No fields yet — add one to describe this type.</div>
          ) : (
            <ul className="ifacedetail__fields">
              {selected.fields.map((field, idx) => (
                <FieldRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: fields are an ordered array with no stable id (F's model) — identity is positional; reorder is a discrete button action, never mid-edit
                  key={`${selected.id}:${idx}`}
                  field={field}
                  index={idx}
                  count={selected.fields.length}
                  interfaces={interfaces}
                  ops={fieldOps(selected.id)}
                  onNavigate={onSelect}
                  onNewInterface={onNewInterface}
                />
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn ifacedetail__addfield"
            onClick={() => onAddField(selected.id)}
          >
            <IconPlus size={12} /> Add field
          </button>
        </div>
      )}
    </aside>
  );
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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [editingPortId, setEditingPortId] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Insert-space gesture (spec D §2.6): Alt reveals a capture overlay; a press-drag opens/tightens a
  // band of space along the locked axis. `spaceDrag` holds the in-flight gesture (base snapshot etc.).
  const [altHeld, setAltHeld] = useState(false);
  const [guide, setGuide] = useState<{ axis: 'x' | 'y'; sx: number; sy: number } | null>(null);
  const spaceDrag = useRef<{
    base: ArchDoc;
    ofx: number;
    ofy: number;
    osx: number;
    osy: number;
    axis: 'x' | 'y' | null;
    active: boolean;
  } | null>(null);
  // Interface authoring panel (spec E): open state, selected interface, delete-confirm, live region.
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedIfaceId, setSelectedIfaceId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [announce, setAnnounce] = useState('');
  // A pending agent proposal for this architecture (N1), or null. Diffed against `doc`.
  const [proposalDiff, setProposalDiff] = useState<ArchDiff | null>(null);
  // Rebuilding the `nodes` prop from `doc` each render wipes React Flow's measured
  // dimensions, and the <MiniMap> skips dimensionless nodes (no silhouette). Capture
  // `dimensions` changes here and feed them back as explicit width/height.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const docRef = useRef(doc);
  docRef.current = doc;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  // Document-level undo/redo (spec F). Every user mutation pushes; a loaded doc resets the stack.
  const historyRef = useRef<History<ArchDoc>>(initHistory(doc));
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
        // Auto-arrange any graph the agent left unpositioned (x/y is the canvas's job, not the
        // agent's — issue #3) so a human never opens a pile of cards stacked at the origin.
        const loaded = autoLayoutUnpositioned(msg.doc ?? seedArchitecture(projectName || 'System'));
        setDoc(loaded);
        docRef.current = loaded;
        historyRef.current = initHistory(loaded);
        setGraphId(loaded.rootGraph);
        setSelectedId(null);
        setEditingEdgeId(null);
        setEditingPortId(null);
        setEditingTitleId(null);
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

  // Escape steps UP one level (to the parent graph); only closes the canvas at the root (spec B).
  // Yields to inline editors (their own Esc) and any open overlay (palette/menu/modal).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      if (document.querySelector('.palette, .modal__backdrop, .ctxmenu')) return;
      const parent = parentOf(docRef.current, graphId);
      if (parent) {
        setSelectedId(null);
        setEditingEdgeId(null);
        setEditingPortId(null);
        setEditingTitleId(null);
        setGraphId(parent.graphId);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [graphId, onClose]);

  // Debounced save with flush on unmount — prevents data loss on quick-close.
  const { schedule: scheduleArchSave } = useDebouncedFlush(() => {
    if (projectPath) post({ type: 'updateArchitecture', path: projectPath, doc: docRef.current });
  }, 300);

  const applyDoc = useCallback(
    (updater: (d: ArchDoc) => ArchDoc, opts?: { history?: 'push' | 'skip'; tag?: string }) => {
      const next = updater(docRef.current);
      if (next === docRef.current) return; // no-op mutation: don't churn history/save
      docRef.current = next;
      setDoc(next);
      // `skip` updates the doc without a history entry (live drag frames); the settling frame
      // pushes once so a whole gesture is one undo step.
      if (opts?.history !== 'skip') {
        historyRef.current = pushHistory(historyRef.current, next, opts?.tag);
      }
      if (projectPath) scheduleArchSave();
    },
    [projectPath, scheduleArchSave],
  );

  const restoreFromHistory = useCallback(
    (next: History<ArchDoc>) => {
      if (next === historyRef.current) return;
      historyRef.current = next;
      docRef.current = next.present;
      setDoc(next.present);
      setEditingEdgeId(null);
      setEditingPortId(null);
      if (projectPath) scheduleArchSave();
    },
    [projectPath, scheduleArchSave],
  );
  const undo = useCallback(
    () => restoreFromHistory(undoHistory(historyRef.current)),
    [restoreFromHistory],
  );
  const redo = useCallback(
    () => restoreFromHistory(redoHistory(historyRef.current)),
    [restoreFromHistory],
  );

  // Undo/redo while the architecture canvas is open. Capture-phase so it beats the app's global
  // file-op undo; skipped when a text field is focused so its native undo wins (spec F precedence).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      // F2 renames the selected component (spec A keyboard path).
      if (e.key === 'F2' && !typing && selectedRef.current) {
        e.preventDefault();
        setEditingTitleId(selectedRef.current);
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      if (typing) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo, redo]);

  // Read-only snapshot for e2e observation (mirrors the window.__sessions pattern in the harness).
  useEffect(() => {
    (window as unknown as { __archDoc?: ArchDoc; __archGraphId?: string }).__archDoc = doc;
    (window as unknown as { __archGraphId?: string }).__archGraphId = graphId;
  }, [doc, graphId]);

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

  const addPortTo = useCallback(
    (nodeId: string, dir: PortDirection) => applyDoc((d) => addPort(d, graphId, nodeId, dir).doc),
    [graphId, applyDoc],
  );
  const removePortFrom = useCallback(
    (nodeId: string, portId: string) => applyDoc((d) => removePort(d, graphId, nodeId, portId)),
    [graphId, applyDoc],
  );
  const startPortEdit = useCallback((portId: string) => setEditingPortId(portId), []);
  const cancelPortEdit = useCallback(() => setEditingPortId(null), []);
  const startTitleEdit = useCallback((nodeId: string) => setEditingTitleId(nodeId), []);
  const cancelTitleEdit = useCallback(() => setEditingTitleId(null), []);
  const commitTitle = useCallback(
    (nodeId: string, title: string) => {
      // Empty reverts (a component must keep a name); updateNode ignores an empty via the guard here.
      if (title.trim()) applyDoc((d) => updateNode(d, graphId, nodeId, { title: title.trim() }));
      setEditingTitleId(null);
    },
    [graphId, applyDoc],
  );
  const onSelectionChange = useCallback((sel: { nodes: { id: string }[] }) => {
    // Only real component nodes are selectable for group/encapsulate — exclude boundary + group boxes.
    const ids = sel.nodes
      .map((n) => n.id)
      .filter((id) => id !== 'boundary:in' && id !== 'boundary:out' && !id.startsWith('grp-'));
    setSelectedIds(ids);
    setSelectedId(ids.length === 1 ? ids[0] : null);
  }, []);
  // Encapsulate the selection into a complex component (spec D); infers ports from crossing wires.
  const encapsulate = useCallback(() => {
    const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : [];
    if (!ids.length) return;
    let created = '';
    applyDoc((d) => {
      const r = encapsulateSelection(d, graphId, ids);
      created = r.componentId;
      return r.doc;
    });
    if (created) {
      setSelectedIds([]);
      setSelectedId(created);
    }
  }, [selectedIds, selectedId, graphId, applyDoc]);
  // Explode a complex component back into this graph (inverse of encapsulate; spec D followup).
  const explode = useCallback(
    (componentId: string) => {
      applyDoc((d) => explodeComponent(d, graphId, componentId));
      setSelectedId(null);
    },
    [graphId, applyDoc],
  );
  // Named groups (spec D): cluster the selection, edit the label in place.
  const makeGroup = useCallback(() => {
    if (selectedIds.length < 2) return;
    applyDoc((d) => addGroup(d, graphId, selectedIds).doc);
  }, [selectedIds, graphId, applyDoc]);
  const startGroupEdit = useCallback((id: string) => setEditingGroupId(id), []);
  const cancelGroupEdit = useCallback(() => setEditingGroupId(null), []);
  const commitGroupLabel = useCallback(
    (id: string, label: string) => {
      if (label.trim()) applyDoc((d) => renameGroup(d, graphId, id, label));
      setEditingGroupId(null);
    },
    [graphId, applyDoc],
  );
  const onGroupContextMenu = useCallback(
    (event: React.MouseEvent, groupId: string) => {
      event.preventDefault();
      const grp = getGraph(docRef.current, graphId)?.groups?.find((g) => g.id === groupId);
      if (!grp) return;
      // Canonical order (spec C §2.2.6): Edit → Reference → Destructive. Ungroup is non-lossy (Edit);
      // only Delete-group-and-contents is destructive.
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            label: 'Rename group…',
            icon: <IconPencil size={13} />,
            onClick: () => setEditingGroupId(grp.id),
          },
          {
            // Encapsulate prunes the (now-empty) group automatically.
            label: 'Encapsulate into component',
            icon: <IconGraph size={13} />,
            onClick: () => applyDoc((d) => encapsulateSelection(d, graphId, grp.memberIds).doc),
          },
          {
            label: 'Ungroup',
            icon: <IconDuplicate size={13} />,
            onClick: () => applyDoc((d) => ungroup(d, graphId, grp.id)),
          },
          {
            label: 'Select contents',
            icon: <IconGraph size={13} />,
            separatorBefore: true,
            onClick: () => setSelectedIds(grp.memberIds),
          },
          {
            label: 'Delete group and contents',
            icon: <IconTrash size={13} />,
            danger: true,
            separatorBefore: true,
            onClick: () => applyDoc((d) => removeGroup(d, graphId, grp.id)),
          },
        ],
      });
    },
    [graphId, applyDoc],
  );
  const commitPortName = useCallback(
    (nodeId: string, portId: string, name: string) => {
      applyDoc((d) => renamePort(d, graphId, nodeId, portId, name));
      setEditingPortId(null);
    },
    [graphId, applyDoc],
  );

  // ---- Interface authoring (spec E) --------------------------------------------------------
  const createInterface = useCallback(
    (name?: string): string => {
      let createdId = '';
      applyDoc((d) => {
        const r = addInterface(d, name ? { name } : {});
        createdId = r.id;
        return r.doc;
      });
      if (createdId) {
        setPanelOpen(true);
        setSelectedIfaceId(createdId);
        setAnnounce(`Created interface ${docRef.current.interfaces?.[createdId]?.name ?? ''}`);
      }
      return createdId;
    },
    [applyDoc],
  );
  const renameInterfaceTo = useCallback(
    (id: string, name: string) => applyDoc((d) => renameInterface(d, id, name)),
    [applyDoc],
  );
  const deleteInterface = useCallback(
    (id: string) => {
      const iface = docRef.current.interfaces?.[id];
      if (!iface) return;
      const n = interfaceUsage(docRef.current)[id] ?? 0;
      const refs = `${n} ${n === 1 ? 'reference' : 'references'}`;
      setConfirm({
        title: `Delete ${iface.name}?`,
        message:
          n > 0
            ? `${refs} will be cleared — ports become untyped, fields become any. The ports and fields themselves are kept.`
            : 'This interface has no references.',
        confirmLabel: 'Delete',
        danger: true,
        focusCancel: true,
        onConfirm: () => {
          applyDoc((d) => removeInterface(d, id));
          setSelectedIfaceId((cur) => (cur === id ? null : cur));
          setAnnounce(`Interface ${iface.name} deleted — ${refs} cleared`);
        },
      });
    },
    [applyDoc],
  );
  const addFieldTo = useCallback(
    (id: string) => applyDoc((d) => addInterfaceField(d, id)),
    [applyDoc],
  );
  const fieldOps = useCallback(
    (id: string): FieldOps => ({
      onRename: (index, name) => applyDoc((d) => updateInterfaceField(d, id, index, { name })),
      onSetType: (index, type) =>
        applyDoc((d) =>
          updateInterfaceField(d, id, index, { type: type ?? { kind: 'primitive', name: 'any' } }),
        ),
      onToggleOptional: (index, optional) =>
        applyDoc((d) => updateInterfaceField(d, id, index, { optional })),
      onMove: (from, to) => applyDoc((d) => moveInterfaceField(d, id, from, to)),
      onRemove: (index) => applyDoc((d) => removeInterfaceField(d, id, index)),
    }),
    [applyDoc],
  );
  const setPortTypeOn = useCallback(
    (nodeId: string, portId: string, type: TypeRef | undefined) =>
      applyDoc((d) => setPortType(d, graphId, nodeId, portId, type)),
    [graphId, applyDoc],
  );

  // ---- Context menus (spec C) --------------------------------------------------------------
  const copyText = useCallback((t: string) => {
    void navigator.clipboard?.writeText(t);
  }, []);
  // "Edit interface…" opens the shared registry entry a ref-typed port points at (through lists).
  const openInterfaceFor = useCallback((type: TypeRef | undefined) => {
    const target = refTargetId(type);
    if (target && docRef.current.interfaces?.[target]) {
      setPanelOpen(true);
      setSelectedIfaceId(target);
    }
  }, []);
  const disconnectEdges = useCallback(
    (edges: { id: string }[]) =>
      applyDoc((d) => {
        let nd = d;
        for (const ed of edges) nd = removeEdge(nd, graphId, ed.id);
        return nd;
      }),
    [graphId, applyDoc],
  );

  const onPortContextMenu = useCallback(
    (e: React.MouseEvent, nodeId: string, portId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const g = getGraph(docRef.current, graphId);
      const node = g?.nodes.find((n) => n.id === nodeId);
      const port = [...(node?.inputs ?? []), ...(node?.outputs ?? [])].find((p) => p.id === portId);
      if (!g || !node || !port) return;
      setSelectedId(nodeId);
      const incident = g.edges.filter(
        (ed) =>
          (ed.source === nodeId && ed.sourcePort === portId) ||
          (ed.target === nodeId && ed.targetPort === portId),
      );
      const items: MenuItem[] = [];
      if (refTargetId(port.type) && docRef.current.interfaces?.[refTargetId(port.type) ?? ''])
        items.push({
          label: 'Edit interface…',
          icon: <IconGraph size={13} />,
          onClick: () => openInterfaceFor(port.type),
        });
      items.push(
        {
          label: 'Rename port…',
          icon: <IconPencil size={13} />,
          separatorBefore: items.length > 0,
          onClick: () => startPortEdit(portId),
        },
        {
          // Routes to the Inspector's Ports section, where the port's type chip opens the picker.
          label: 'Set type…',
          icon: <IconGraph size={13} />,
          onClick: () => {
            setPanelOpen(false);
            setSelectedId(nodeId);
          },
        },
        {
          label: 'Copy port name',
          icon: <IconDuplicate size={13} />,
          separatorBefore: true,
          onClick: () => copyText(port.name),
        },
        {
          label: 'Disconnect wires',
          icon: <IconTrash size={13} />,
          danger: true,
          separatorBefore: true,
          disabled: incident.length === 0,
          onClick: () => disconnectEdges(incident),
        },
        {
          label: 'Remove port',
          icon: <IconTrash size={13} />,
          danger: true,
          onClick: () => removePortFrom(nodeId, portId),
        },
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [graphId, startPortEdit, removePortFrom, copyText, openInterfaceFor, disconnectEdges],
  );

  // Boundary pins are the parent's contract — read-only inside the child (spec F/C): no rename/
  // set-type/remove; only Copy name, Edit interface (if ref), and disconnecting internal wiring.
  const onBoundaryPortContextMenu = useCallback(
    (e: React.MouseEvent, portId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const parent = parentOf(docRef.current, graphId);
      const g = getGraph(docRef.current, graphId);
      if (!parent || !g) return;
      const port = [...(parent.node.inputs ?? []), ...(parent.node.outputs ?? [])].find(
        (p) => p.id === portId,
      );
      if (!port) return;
      const incident = g.edges.filter(
        (ed) =>
          (ed.source === 'boundary:in' && ed.sourcePort === portId) ||
          (ed.target === 'boundary:out' && ed.targetPort === portId),
      );
      const items: MenuItem[] = [];
      if (refTargetId(port.type) && docRef.current.interfaces?.[refTargetId(port.type) ?? ''])
        items.push({
          label: 'Edit interface…',
          icon: <IconGraph size={13} />,
          onClick: () => openInterfaceFor(port.type),
        });
      items.push(
        {
          label: 'Copy port name',
          icon: <IconDuplicate size={13} />,
          separatorBefore: items.length > 0,
          onClick: () => copyText(port.name),
        },
        {
          label: 'Disconnect wires',
          icon: <IconTrash size={13} />,
          danger: true,
          separatorBefore: true,
          disabled: incident.length === 0,
          onClick: () => disconnectEdges(incident),
        },
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [graphId, copyText, openInterfaceFor, disconnectEdges],
  );

  // Restore the pre-gesture snapshot (Esc, or Alt released mid-drag) without a history entry.
  const abortSpace = useCallback(() => {
    const s = spaceDrag.current;
    if (s?.active) applyDoc(() => s.base, { history: 'skip' });
    spaceDrag.current = null;
    setGuide(null);
  }, [applyDoc]);

  // Track the Alt modifier to show/hide the insert-space capture overlay (spec D §2.6).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        setAltHeld(false);
        abortSpace();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [abortSpace]);

  const SPACE_THRESHOLD = 6; // px before the axis locks to the dominant drag direction
  const onSpacePointerDown = (e: React.PointerEvent) => {
    const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    spaceDrag.current = {
      base: docRef.current,
      ofx: flow.x,
      ofy: flow.y,
      osx: e.clientX,
      osy: e.clientY,
      axis: null,
      active: true,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSpacePointerMove = (e: React.PointerEvent) => {
    const s = spaceDrag.current;
    if (!s?.active) return;
    if (!s.axis) {
      const sdx = e.clientX - s.osx;
      const sdy = e.clientY - s.osy;
      if (Math.abs(sdx) < SPACE_THRESHOLD && Math.abs(sdy) < SPACE_THRESHOLD) return;
      s.axis = Math.abs(sdx) > Math.abs(sdy) ? 'x' : 'y';
      setGuide({ axis: s.axis, sx: s.osx, sy: s.osy });
    }
    const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const delta = s.axis === 'x' ? flow.x - s.ofx : flow.y - s.ofy;
    const origin = s.axis === 'x' ? s.ofx : s.ofy;
    // Live preview off the pre-gesture snapshot; the whole gesture commits as one undo step on release.
    applyDoc(() => insertSpace(s.base, graphId, s.axis as 'x' | 'y', origin, delta), {
      history: 'skip',
    });
  };
  const onSpacePointerUp = () => {
    const s = spaceDrag.current;
    if (!s) return;
    const moved = s.active && s.axis && docRef.current !== s.base;
    spaceDrag.current = null;
    setGuide(null);
    if (moved) historyRef.current = pushHistory(historyRef.current, docRef.current, 'insert-space');
  };
  // Esc aborts an in-flight insert-space drag; capture-phase + stopPropagation so the Escape-steps-up
  // handler doesn't also fire and navigate away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && spaceDrag.current?.active) {
        e.preventDefault();
        e.stopPropagation();
        abortSpace();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [abortSpace]);

  const rfNodes: Node[] = useMemo(() => {
    if (!graph) return [];
    const nodes: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'arch',
      position: { x: n.x, y: n.y },
      // Selection is controlled via `selectedIds` so it survives the doc-driven rebuild (a bare
      // rebuild would drop `selected` and reset any programmatic/multi selection).
      selected: selectedIds.includes(n.id),
      // Re-apply the measured size so the rebuilt node keeps its dimensions AND React Flow's handle
      // bounds (feeding top-level width/height instead resets internals on move → edges vanish, #2).
      ...(sizes[n.id] ? { measured: { ...sizes[n.id] } } : {}),
      data: {
        title: n.title,
        subtitle: n.subtitle,
        // Migrate at the render boundary so a legacy/unknown kind (old in-memory doc) still
        // hits a current KIND_VAR/KIND_ICON entry and never renders blank.
        kind: migrateKind(n.kind),
        hasChild: !!n.childGraph,
        icon: n.icon,
        inputs: n.inputs,
        outputs: n.outputs,
        typeLabels: portTypeLabels(n, doc.interfaces),
        // A component with no summary, ports, or child graph is still "unconfigured" (spec A).
        empty: !n.subtitle && !n.childGraph && !(n.inputs?.length || n.outputs?.length),
        editingPortId,
        editingTitle: n.id === editingTitleId,
        onDrill: drillInto,
        onAddPort: addPortTo,
        onRemovePort: removePortFrom,
        onStartPortEdit: startPortEdit,
        onCommitPortName: commitPortName,
        onCancelPortEdit: cancelPortEdit,
        onStartTitleEdit: startTitleEdit,
        onCommitTitle: commitTitle,
        onCancelTitleEdit: cancelTitleEdit,
        onPortContextMenu,
      } as ArchNodeData,
    }));
    // Inside a child graph, surface the parent component's declared ports as read-only boundary
    // nodes (spec F): boundary:in (left) exposes inputs, boundary:out (right) exposes outputs.
    const parent = parentOf(doc, graphId);
    if (parent) {
      const xs = graph.nodes.map((n) => n.x);
      const ys = graph.nodes.map((n) => n.y);
      const minX = xs.length ? Math.min(...xs) : 0;
      const maxX = xs.length ? Math.max(...xs) : 400;
      const midY = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 80;
      const boundary = (dir: PortDirection, ports: Port[] | undefined, x: number): Node => ({
        id: dir === 'in' ? 'boundary:in' : 'boundary:out',
        type: 'archBoundary',
        position: { x, y: midY },
        draggable: false,
        selectable: false,
        deletable: false,
        data: {
          dir,
          title: `${parent.node.title} · ${dir === 'in' ? 'inputs' : 'outputs'}`,
          ports: ports ?? [],
          onPortContextMenu: onBoundaryPortContextMenu,
        } as BoundaryData,
      });
      if (parent.node.inputs?.length) nodes.push(boundary('in', parent.node.inputs, minX - 260));
      if (parent.node.outputs?.length) nodes.push(boundary('out', parent.node.outputs, maxX + 260));
    }
    // Named group boxes (spec D) — a padded bounding box behind the members, with an editable label.
    const groupNodes: Node[] = [];
    const GW = 200;
    const GH = 90;
    const PAD = 22;
    const LABEL = 20;
    for (const grp of graph.groups ?? []) {
      const members = grp.memberIds
        .map((id) => graph.nodes.find((n) => n.id === id))
        .filter((n): n is ArchNode => !!n);
      if (!members.length) continue;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const m of members) {
        minX = Math.min(minX, m.x);
        minY = Math.min(minY, m.y);
        maxX = Math.max(maxX, m.x + (sizes[m.id]?.width ?? GW));
        maxY = Math.max(maxY, m.y + (sizes[m.id]?.height ?? GH));
      }
      groupNodes.push({
        id: grp.id,
        type: 'archGroup',
        position: { x: minX - PAD, y: minY - PAD - LABEL },
        width: maxX - minX + PAD * 2,
        height: maxY - minY + PAD * 2 + LABEL,
        draggable: false,
        selectable: false,
        zIndex: -1,
        data: {
          label: grp.label,
          groupId: grp.id,
          editing: editingGroupId === grp.id,
          onStartEdit: startGroupEdit,
          onCommit: commitGroupLabel,
          onCancel: cancelGroupEdit,
          onContextMenu: (e: React.MouseEvent) => onGroupContextMenu(e, grp.id),
        } as GroupData,
      });
    }
    // Group boxes first so they paint behind the component cards.
    return [...groupNodes, ...nodes];
  }, [
    graph,
    graphId,
    doc,
    selectedIds,
    drillInto,
    sizes,
    editingPortId,
    editingTitleId,
    addPortTo,
    removePortFrom,
    startPortEdit,
    commitPortName,
    cancelPortEdit,
    startTitleEdit,
    commitTitle,
    cancelTitleEdit,
    onPortContextMenu,
    onBoundaryPortContextMenu,
    editingGroupId,
    startGroupEdit,
    commitGroupLabel,
    cancelGroupEdit,
    onGroupContextMenu,
  ]);

  const startEdgeEdit = useCallback((edgeId: string) => setEditingEdgeId(edgeId), []);
  const cancelEdgeEdit = useCallback(() => setEditingEdgeId(null), []);
  const commitEdgeLabel = useCallback(
    (edgeId: string, label: string) => {
      applyDoc((d) => setEdgeLabel(d, graphId, edgeId, label));
      setEditingEdgeId(null);
    },
    [graphId, applyDoc],
  );
  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      e.preventDefault();
      const model = getGraph(docRef.current, graphId)?.edges.find((ed) => ed.id === edge.id);
      if (!model) return;
      const items: MenuItem[] = [
        {
          label: 'Edit label…',
          icon: <IconPencil size={13} />,
          onClick: () => startEdgeEdit(edge.id),
        },
      ];
      if (model.label)
        items.push({
          label: 'Copy label',
          icon: <IconDuplicate size={13} />,
          separatorBefore: true,
          onClick: () => copyText(model.label ?? ''),
        });
      items.push({
        label: 'Delete edge',
        icon: <IconTrash size={13} />,
        danger: true,
        separatorBefore: true,
        onClick: () => applyDoc((d) => removeEdge(d, graphId, edge.id)),
      });
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [graphId, applyDoc, startEdgeEdit, copyText],
  );

  const rfEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourcePort ? { sourceHandle: e.sourcePort } : {}),
      ...(e.targetPort ? { targetHandle: e.targetPort } : {}),
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

      // Skip history while a drag is mid-flight (dragging:true); the release frame (dragging:false)
      // pushes once so a whole drag is a single undo step.
      const dragging = changes.some((c) => c.type === 'position' && c.dragging);
      const hasRemove = changes.some((c) => c.type === 'remove');
      applyDoc(
        (d) => {
          let nd = d;
          for (const c of changes) {
            if (c.type === 'position' && c.position)
              nd = updateNode(nd, graphId, c.id, { x: c.position.x, y: c.position.y });
            else if (c.type === 'remove') nd = removeNode(nd, graphId, c.id);
          }
          return nd;
        },
        { history: dragging && !hasRemove ? 'skip' : 'push' },
      );
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
      const { source, target, sourceHandle, targetHandle } = c;
      if (!source || !target) return;
      // Port handles carry the port id; a connection between two of them is a typed edge.
      if (sourceHandle && targetHandle)
        applyDoc((d) => addTypedEdge(d, graphId, source, sourceHandle, target, targetHandle));
      else applyDoc((d) => addEdge(d, graphId, source, target));
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
      if (createdId) {
        setSelectedId(createdId);
        setEditingTitleId(createdId); // spec A: a new component spawns in title-edit
      }
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

  // Re-arrange the current graph with the layered algorithm (issue #3), then fit it. Undoable.
  const tidy = useCallback(() => {
    applyDoc((d) => applyAutoLayout(d, graphId), { tag: 'tidy' });
    requestAnimationFrame(() => rf.fitView({ padding: 0.2, maxZoom: 1.2, duration: 300 }));
  }, [graphId, applyDoc, rf]);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      setSelectedId(node.id);
      const model = graph?.nodes.find((n) => n.id === node.id);
      if (!model) return;
      const multi = selectedIds.length >= 2 && selectedIds.includes(node.id);
      // Canonical order (spec C §2.1): Primary → Create → Edit → Reference → Destructive.
      const items: MenuItem[] = [
        {
          label: model.childGraph ? 'Open nested canvas' : 'Create nested canvas',
          icon: <IconChevron size={13} />,
          onClick: () => drillInto(node.id),
        },
        {
          label: 'Add connected node',
          icon: <IconPlus size={13} />,
          separatorBefore: true,
          onClick: () => {
            const newId = addComponentAt(model.x + 240, model.y);
            if (newId) applyDoc((d) => addEdge(d, graphId, node.id, newId));
          },
        },
        {
          label: 'Add input port',
          icon: <IconPlus size={13} />,
          onClick: () => addPortTo(node.id, 'in'),
        },
        {
          label: 'Add output port',
          icon: <IconPlus size={13} />,
          onClick: () => addPortTo(node.id, 'out'),
        },
      ];
      if (multi)
        items.push(
          {
            label: 'Group selection',
            icon: <IconGraph size={13} />,
            onClick: makeGroup,
          },
          {
            label: 'Encapsulate selection into component',
            icon: <IconGraph size={13} />,
            onClick: encapsulate,
          },
        );
      items.push(
        {
          label: 'Rename…',
          icon: <IconPencil size={13} />,
          separatorBefore: true,
          onClick: () => setEditingTitleId(node.id),
        },
        {
          label: 'Edit description…',
          icon: <IconPencil size={13} />,
          onClick: () => {
            setPanelOpen(false);
            setSelectedId(node.id);
          },
        },
        {
          label: 'Set icon…',
          icon: <IconPencil size={13} />,
          onClick: () => {
            setPanelOpen(false);
            setSelectedId(node.id);
          },
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
        ...(model.childGraph
          ? [
              {
                label: 'Explode component',
                icon: <IconGraph size={13} />,
                onClick: () => explode(node.id),
              },
            ]
          : []),
        {
          label: 'Copy name',
          icon: <IconDuplicate size={13} />,
          separatorBefore: true,
          onClick: () => copyText(model.title),
        },
        {
          label: 'Delete component',
          icon: <IconTrash size={13} />,
          danger: true,
          separatorBefore: true,
          onClick: () => {
            applyDoc((d) => removeNode(d, graphId, node.id));
            setSelectedId(null);
          },
        },
      );
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [
      graph,
      graphId,
      selectedIds,
      applyDoc,
      drillInto,
      addComponentAt,
      addPortTo,
      encapsulate,
      explode,
      makeGroup,
      copyText,
    ],
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
      const g = getGraph(docRef.current, graphId);
      const parent = parentOf(docRef.current, graphId);
      const items: MenuItem[] = [];
      if (parent)
        items.push({
          label: 'Go up to parent',
          icon: <IconChevron size={13} />,
          onClick: () => {
            setSelectedId(null);
            setEditingEdgeId(null);
            setGraphId(parent.graphId);
          },
        });
      items.push(
        {
          label: 'Add component here',
          icon: <IconPlus size={13} />,
          separatorBefore: items.length > 0,
          onClick: () => addComponentAt(pos.x - 90, pos.y - 30),
        },
        {
          // Non-pointer path for insert-space (the Alt-drag gesture's keyboard-reachable equivalent).
          label: 'Insert horizontal space',
          icon: <IconPlus size={13} />,
          onClick: () => applyDoc((d) => insertSpace(d, graphId, 'x', pos.x, 140)),
        },
        {
          label: 'Insert vertical space',
          icon: <IconPlus size={13} />,
          onClick: () => applyDoc((d) => insertSpace(d, graphId, 'y', pos.y, 140)),
        },
      );
      if ((g?.nodes.length ?? 0) > 0)
        items.push({
          label: 'Select all',
          icon: <IconGraph size={13} />,
          separatorBefore: true,
          onClick: () => {
            const gg = getGraph(docRef.current, graphId);
            if (gg) setSelectedIds(gg.nodes.map((n) => n.id));
          },
        });
      items.push({
        label: 'Fit view',
        icon: <IconGraph size={13} />,
        separatorBefore: (g?.nodes.length ?? 0) === 0,
        onClick: () => rf.fitView({ padding: 0.25, maxZoom: 1.2, duration: 200 }),
      });
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [rf, graphId, addComponentAt, applyDoc],
  );

  const crumbs = breadcrumb(doc, graphId);
  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;
  const ifaceCount = Object.keys(doc.interfaces ?? {}).length;

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
        {selectedIds.length >= 2 && (
          <button
            className="btn arch__makegroup"
            title="Cluster the selection into a named group"
            onClick={makeGroup}
          >
            <IconGraph size={13} /> Group
          </button>
        )}
        {selectedIds.length >= 1 && (
          <button
            className="btn arch__group"
            title="Group the selection into a nested component"
            onClick={encapsulate}
          >
            <IconGraph size={13} /> Encapsulate
          </button>
        )}
        <button
          className={`btn arch__ifacesbtn${panelOpen ? ' arch__ifacesbtn--on' : ''}`}
          title="Document interfaces / types"
          aria-label="Interfaces"
          aria-pressed={panelOpen}
          onClick={() => setPanelOpen((o) => !o)}
        >
          <IconGraph size={13} /> Interfaces
          {ifaceCount > 0 && <span className="arch__ifacesbadge">{ifaceCount}</span>}
        </button>
        <button
          className="btn arch__tidy"
          title="Auto-arrange this graph (layered layout)"
          onClick={tidy}
        >
          <IconGraph size={13} /> Tidy
        </button>
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
          onSelectionChange={onSelectionChange}
          onNodeClick={(_e, n) => {
            if (n.type === 'arch') setSelectedId(n.id);
          }}
          onNodeDoubleClick={(_e, n) => drillInto(n.id)}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
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

        {/* Interfaces is document-scoped, so it takes precedence over the per-node Inspector
            (spec E §2 — they never stack). */}
        {panelOpen ? (
          <InterfacesPanel
            doc={doc}
            selectedId={selectedIfaceId}
            onSelect={setSelectedIfaceId}
            onCreate={createInterface}
            onRename={renameInterfaceTo}
            onDelete={deleteInterface}
            onAddField={addFieldTo}
            fieldOps={fieldOps}
            onNewInterface={createInterface}
            onClose={() => setPanelOpen(false)}
          />
        ) : (
          selected && (
            <Inspector
              key={selected.id}
              node={selected}
              interfaces={doc.interfaces ?? {}}
              onChange={(patch) => applyDoc((d) => updateNode(d, graphId, selected.id, patch))}
              onDrill={() => drillInto(selected.id)}
              onSetPortType={(portId, type) => setPortTypeOn(selected.id, portId, type)}
              onNewInterface={createInterface}
              onDelete={() => {
                applyDoc((d) => removeNode(d, graphId, selected.id));
                setSelectedId(null);
              }}
            />
          )
        )}

        {/* Insert-space (spec D §2.6): while Alt is held this overlay captures the press-drag so it
            never reaches React Flow's pan; the guide line marks the anchored axis. */}
        {altHeld && (
          <div
            className="arch__spaceoverlay"
            onPointerDown={onSpacePointerDown}
            onPointerMove={onSpacePointerMove}
            onPointerUp={onSpacePointerUp}
          />
        )}
        {guide && (
          <div
            className={`arch__guide arch__guide--${guide.axis}`}
            style={guide.axis === 'x' ? { left: guide.sx } : { top: guide.sy }}
          />
        )}
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
      <div className="arch__live" aria-live="polite" role="status">
        {announce}
      </div>
    </div>
  );
}

/** The selected node's ports, each with a type chip that opens the shared picker (spec E §2.5). */
function PortTypeList({
  node,
  interfaces,
  onSetPortType,
  onNewInterface,
}: {
  node: ArchNode;
  interfaces: Record<string, InterfaceDef>;
  onSetPortType: (portId: string, type: TypeRef | undefined) => void;
  onNewInterface: (name: string | undefined) => string;
}) {
  const rows: { dir: PortDirection; port: Port }[] = [
    ...(node.inputs ?? []).map((port) => ({ dir: 'in' as const, port })),
    ...(node.outputs ?? []).map((port) => ({ dir: 'out' as const, port })),
  ];
  if (rows.length === 0) {
    return (
      <div className="arch__portsempty">
        No ports yet — add pins on the card, then type them here.
      </div>
    );
  }
  return (
    <ul className="arch__portlist">
      {rows.map(({ dir, port }) => (
        <li className="arch__portrow" key={port.id}>
          <span className={`arch__portdir arch__portdir--${dir}`}>{dir}</span>
          <span className="arch__portlabel">{port.name}</span>
          <TypeChip
            type={port.type}
            interfaces={interfaces}
            allowUntyped
            ariaLabel={`Type of ${port.name}`}
            onPick={(t) => onSetPortType(port.id, t)}
            onNewInterface={onNewInterface}
          />
        </li>
      ))}
    </ul>
  );
}

function Inspector({
  node,
  interfaces,
  onChange,
  onDrill,
  onSetPortType,
  onNewInterface,
  onDelete,
}: {
  node: ArchNode;
  interfaces: Record<string, InterfaceDef>;
  onChange: (patch: {
    title?: string;
    subtitle?: string;
    kind?: ArchKind;
    icon?: string;
    description?: string;
  }) => void;
  onDrill: () => void;
  onSetPortType: (portId: string, type: TypeRef | undefined) => void;
  onNewInterface: (name: string | undefined) => string;
  onDelete: () => void;
}) {
  const title = node.title;
  const subtitle = node.subtitle ?? '';
  const kind = migrateKind(node.kind);
  const icon = node.icon;
  const description = node.description ?? '';
  const hasChild = !!node.childGraph;
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
        <span>Icon</span>
        <div className="arch__iconpicker">
          {ARCH_KINDS.map((k) => {
            const Ico = KIND_ICON[k.id];
            const active = icon === k.id;
            return (
              <button
                type="button"
                key={k.id}
                className={`arch__iconopt${active ? ' arch__iconopt--active' : ''}`}
                title={k.label}
                aria-label={k.label}
                aria-pressed={active}
                onClick={() => onChange({ icon: k.id })}
              >
                {Ico ? <Ico size={14} /> : null}
              </button>
            );
          })}
          <button
            type="button"
            className="arch__iconopt arch__iconreset"
            title="Reset to kind default"
            aria-label="Reset icon to kind default"
            onClick={() => onChange({ icon: undefined })}
          >
            ⟲
          </button>
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
      <div className="arch__field arch__portsfield">
        <span>Ports</span>
        <PortTypeList
          node={node}
          interfaces={interfaces}
          onSetPortType={onSetPortType}
          onNewInterface={onNewInterface}
        />
      </div>
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
