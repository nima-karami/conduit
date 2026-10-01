import { describe, expect, it } from 'vitest';
import { type FlowGraph, parseFlowchart } from '../../src/mermaid-flow';
import {
  applyFlowEdits,
  encodeLabel,
  type FlowEdit,
  nextNodeId,
} from '../../src/mermaid-flow-edit';

/** The `fidelity.md` fence (test/e2e/fixtures/plan/fidelity.md), inlined. Edge order: e0 src→parse,
 *  e1 parse→enrich, e2 enrich→sink, e3 parse→db "batch", e4 enrich→w1, e5 w1→w2 (dotted). */
const FIDELITY = [
  'flowchart LR',
  '    %% ingest pipeline',
  '    src[Source] --> parse[Parse] --> enrich(Enrich) --> sink',
  '    parse -- batch --> db[(Store)]',
  '    subgraph workers [Workers]',
  '        w1[Worker one]',
  '        w2{{Worker two}}',
  '    end',
  '    %% wiring',
  '    enrich --> w1',
  '    w1 -.-> w2',
  '    classDef hot fill:#f96',
  '    class src,db hot',
  '    linkStyle 1 stroke:#0a0',
].join('\n');

type NodeShape = [id: string, label: string, shape: string, parent: string | null];
type EdgeShape = [source: string, kind: string, label: string | null, target: string];

/** A test-local projection: no spans, nodes by id so a membership move doesn't reorder them. */
interface GraphShape {
  nodes: NodeShape[];
  edges: EdgeShape[];
  subgraphs: [id: string, title: string, parent: string | null][];
}

function shapeOf(g: FlowGraph): GraphShape {
  return {
    nodes: g.nodes
      .map((n): NodeShape => [n.id, n.label, n.shape, n.parent])
      .sort((a, b) => a[0].localeCompare(b[0])),
    edges: g.edges.map((e): EdgeShape => [e.source, e.kind, e.label, e.target]),
    subgraphs: g.subgraphs.map((s) => [s.id, s.title, s.parent]),
  };
}

const BASE_NODES: NodeShape[] = [
  ['db', 'Store', 'cylinder', null],
  ['enrich', 'Enrich', 'round', null],
  ['parse', 'Parse', 'rect', null],
  ['sink', 'sink', 'rect', null],
  ['src', 'Source', 'rect', null],
  ['w1', 'Worker one', 'rect', 'workers'],
  ['w2', 'Worker two', 'hexagon', 'workers'],
];
const E0: EdgeShape = ['src', 'arrow', null, 'parse'];
const E1: EdgeShape = ['parse', 'arrow', null, 'enrich'];
const E2: EdgeShape = ['enrich', 'arrow', null, 'sink'];
const E3: EdgeShape = ['parse', 'arrow', 'batch', 'db'];
const E4: EdgeShape = ['enrich', 'arrow', null, 'w1'];
const E5: EdgeShape = ['w1', 'dotted', null, 'w2'];
const WORKERS: [string, string, string | null] = ['workers', 'Workers', null];

const nodesWith = (id: string, next: NodeShape | null): NodeShape[] =>
  BASE_NODES.flatMap((n) => (n[0] === id ? (next ? [next] : []) : [n]));

/** Input line indices that do not survive byte-identical, in order, into the output (LCS). */
function changedInputLines(input: string[], output: string[]): number[] {
  const n = input.length;
  const m = output.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        input[i] === output[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const changed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n) {
    if (j < m && input[i] === output[j]) {
      i++;
      j++;
    } else if (j < m && lcs[i][j + 1] >= lcs[i + 1][j]) j++;
    else changed.push(i++);
  }
  return changed;
}

interface Case {
  name: string;
  source: string;
  edits: FlowEdit[];
  expected: GraphShape;
  changedLines: number[];
  /** Exact output lines, by output index, where the spelling is the point. */
  lines?: Record<number, string>;
}

function check(c: Case): string {
  const result = applyFlowEdits(c.source, c.edits);
  if (!result.ok) throw new Error(`refused: ${result.refusal} at ${result.at}`);
  const reparsed = parseFlowchart(result.source);
  if (!reparsed.ok) throw new Error(`unparsable output: ${reparsed.reason}\n${result.source}`);
  expect(shapeOf(reparsed.doc.graph)).toEqual(c.expected);
  expect(shapeOf(result.doc.graph)).toEqual(c.expected);
  const out = result.source.split('\n');
  expect(changedInputLines(c.source.split('\n'), out)).toEqual(c.changedLines);
  for (const [at, text] of Object.entries(c.lines ?? {})) expect(out[Number(at)]).toBe(text);
  return result.source;
}

const CASES: Case[] = [
  {
    name: 'relabel one edge changes exactly one line',
    source: FIDELITY,
    edits: [{ op: 'relabelEdge', edge: 3, label: 'load' }],
    expected: {
      nodes: BASE_NODES,
      edges: [E0, E1, E2, ['parse', 'arrow', 'load', 'db'], E4, E5],
      subgraphs: [WORKERS],
    },
    changedLines: [3],
    lines: { 3: '    parse -- load --> db[(Store)]' },
  },
  {
    name: 'rename rewrites only the def mention, inside a chain',
    source: FIDELITY,
    edits: [
      { op: 'renameNode', id: 'parse', label: 'Parser' },
      { op: 'renameNode', id: 'sink', label: 'Sink' },
    ],
    expected: {
      nodes: nodesWith('parse', ['parse', 'Parser', 'rect', null]).map((n) =>
        n[0] === 'sink' ? ['sink', 'Sink', 'rect', null] : n,
      ),
      edges: [E0, E1, E2, E3, E4, E5],
      subgraphs: [WORKERS],
    },
    changedLines: [2],
    lines: { 2: '    src[Source] --> parse[Parser] --> enrich(Enrich) --> sink[Sink]' },
  },
  {
    name: 'addEdge appends at top-level end before trailer, sibling indent',
    source: FIDELITY,
    edits: [{ op: 'addEdge', source: 'sink', target: 'db', kind: 'arrow', label: null }],
    expected: {
      nodes: BASE_NODES,
      edges: [E0, E1, E2, E3, E4, E5, ['sink', 'arrow', null, 'db']],
      subgraphs: [WORKERS],
    },
    changedLines: [],
    lines: {
      11: '    sink --> db',
      12: '    classDef hot fill:#f96',
      14: '    linkStyle 1 stroke:#0a0',
    },
  },
  {
    name: 'reconnect away from a node defined in that edge keeps its label',
    source: FIDELITY,
    edits: [{ op: 'reconnectEdge', edge: 3, source: 'parse', target: 'sink' }],
    expected: {
      nodes: BASE_NODES,
      edges: [E0, E1, E2, ['parse', 'arrow', 'batch', 'sink'], E4, E5],
      subgraphs: [WORKERS],
    },
    changedLines: [3],
    lines: { 3: '    parse -- batch --> sink', 4: '    db[(Store)]' },
  },
  {
    name: 'reconnect keeps label and kind',
    source: FIDELITY,
    edits: [{ op: 'reconnectEdge', edge: 5, source: 'w1', target: 'sink' }],
    expected: {
      nodes: BASE_NODES,
      edges: [E0, E1, E2, E3, E4, ['w1', 'dotted', null, 'sink']],
      subgraphs: [WORKERS],
    },
    changedLines: [10],
    lines: { 10: '    w1 -.-> sink' },
  },
  {
    name: 'batch indices address the input doc',
    source: FIDELITY,
    edits: [
      { op: 'removeEdge', edge: 1 },
      { op: 'removeEdge', edge: 2 },
    ],
    expected: { nodes: BASE_NODES, edges: [E0, E3, E4, E5], subgraphs: [WORKERS] },
    changedLines: [2, 13],
    lines: { 2: '    src[Source] --> parse[Parse]', 3: '    enrich(Enrich)', 4: '    sink' },
  },
  {
    name: "removeNode keeps neighbours' labels and parents",
    source: FIDELITY,
    edits: [{ op: 'removeNode', id: 'parse' }],
    expected: { nodes: nodesWith('parse', null), edges: [E2, E4, E5], subgraphs: [WORKERS] },
    changedLines: [2, 3, 13],
    lines: {
      2: '    src[Source]',
      3: '    enrich(Enrich) --> sink',
      4: '    db[(Store)]',
      13: '    class src,db hot',
    },
  },
  {
    name: 'linkStyle renumbered after removing an earlier edge',
    source: FIDELITY,
    edits: [{ op: 'removeEdge', edge: 0 }],
    expected: { nodes: BASE_NODES, edges: [E1, E2, E3, E4, E5], subgraphs: [WORKERS] },
    changedLines: [2, 13],
    lines: {
      2: '    src[Source]',
      3: '    parse[Parse] --> enrich(Enrich) --> sink',
      14: '    linkStyle 0 stroke:#0a0',
    },
  },
  {
    name: 'renameSubgraph rewrites only its header',
    source: FIDELITY,
    edits: [{ op: 'renameSubgraph', id: 'workers', title: 'Pool (2)' }],
    expected: {
      nodes: BASE_NODES,
      edges: [E0, E1, E2, E3, E4, E5],
      subgraphs: [['workers', 'Pool (2)', null]],
    },
    changedLines: [4],
    lines: { 4: '    subgraph workers ["Pool (2)"]' },
  },
  {
    name: 'removeSubgraph lifts members, keeps edges, drops header/end',
    source: FIDELITY,
    edits: [{ op: 'removeSubgraph', id: 'workers' }],
    expected: {
      nodes: BASE_NODES.map((n) => (n[3] === 'workers' ? [n[0], n[1], n[2], null] : n)),
      edges: [E0, E1, E2, E3, E4, E5],
      subgraphs: [],
    },
    changedLines: [4, 7],
  },
  {
    name: 'moveToSubgraph removes standalone decl and appends id[Label] at target end',
    source: FIDELITY,
    edits: [{ op: 'moveToSubgraph', id: 'w2', subgraph: null }],
    expected: {
      nodes: nodesWith('w2', ['w2', 'Worker two', 'hexagon', null]),
      edges: [E0, E1, E2, E3, E4, E5],
      subgraphs: [WORKERS],
    },
    changedLines: [6],
    lines: { 9: '    w1 -.-> w2', 10: '    w2{{Worker two}}', 11: '    classDef hot fill:#f96' },
  },
  {
    // Top-level mentions confer no membership in mermaid, so listing `sink` in the target is all
    // a move needs: the chain that mentions it stays where it is.
    name: 'a move into a subgraph only adds the listing; top-level mentions stay put',
    source: FIDELITY,
    edits: [{ op: 'moveToSubgraph', id: 'sink', subgraph: 'workers' }],
    expected: {
      nodes: nodesWith('sink', ['sink', 'sink', 'rect', 'workers']),
      edges: [E0, E1, E2, E3, E4, E5],
      subgraphs: [WORKERS],
    },
    changedLines: [],
    lines: { 7: '        sink', 8: '    end', 14: '    linkStyle 1 stroke:#0a0' },
  },
  {
    name: 'a move out of a subgraph relocates the edge that listed it there',
    source: FIDELITY,
    edits: [{ op: 'moveToSubgraph', id: 'w1', subgraph: null }],
    expected: {
      nodes: nodesWith('w1', ['w1', 'Worker one', 'rect', null]),
      edges: [E0, E1, E2, E3, E4, E5],
      subgraphs: [WORKERS],
    },
    changedLines: [5],
    lines: { 10: '    w1[Worker one]', 11: '    classDef hot fill:#f96' },
  },
];

describe('applyFlowEdits — fidelity corpus', () => {
  it.each(CASES)('$name', (c) => {
    check(c);
  });

  it('every corpus edit leaves the %% lines in place', () => {
    for (const c of CASES) {
      const result = applyFlowEdits(c.source, c.edits);
      expect(result.ok && result.source.includes('    %% ingest pipeline\n')).toBe(true);
      expect(result.ok && result.source.includes('    %% wiring\n')).toBe(true);
    }
  });
});

describe('applyFlowEdits — node and edge edits', () => {
  it('relabel a chain link splits only that chain', () => {
    const r = applyFlowEdits('flowchart LR\n  a --> b --> c\n  c --> d', [
      { op: 'relabelEdge', edge: 1, label: 'x' },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\n  a --> b\n  b -->|x| c\n  c --> d');
  });

  it('chain split keeps the label on its defining fragment', () => {
    const middle = applyFlowEdits('flowchart LR\n  a --> b[Bee] --> c[Cee] --> d', [
      { op: 'relabelEdge', edge: 1, label: 'x' },
    ]);
    expect(middle.ok && middle.source).toBe(
      'flowchart LR\n  a --> b[Bee]\n  b -->|x| c[Cee]\n  c --> d',
    );
    const first = applyFlowEdits('flowchart LR\n  a --> b[Bee] --> c', [
      { op: 'setEdgeKind', edge: 0, kind: 'thick' },
    ]);
    expect(first.ok && first.source).toBe('flowchart LR\n  a ==> b[Bee]\n  b --> c');
  });

  it('setShape cylinder → `db[(Store)]`', () => {
    const r = applyFlowEdits('flowchart LR\n  db[Store] --> x', [
      { op: 'setShape', id: 'db', shape: 'cylinder' },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\n  db[(Store)] --> x');
    const hex = applyFlowEdits('flowchart LR\n  h', [
      { op: 'setShape', id: 'h', shape: 'hexagon' },
    ]);
    expect(hex.ok && hex.source).toBe('flowchart LR\n  h{{h}}');
  });

  it('setShape on verbatim replaces the brackets', () => {
    const r = applyFlowEdits('flowchart LR\n  n>Flag] --> m', [
      { op: 'setShape', id: 'n', shape: 'round' },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\n  n(Flag) --> m');
    const renamed = applyFlowEdits('flowchart LR\n  p[/Para\\]', [
      { op: 'renameNode', id: 'p', label: 'Trap' },
    ]);
    expect(renamed.ok && renamed.source).toBe('flowchart LR\n  p[/Trap\\]');
  });

  it('duplicate refused only on same kind+label', () => {
    const add = (kind: 'arrow' | 'dotted', label: string | null) =>
      applyFlowEdits(FIDELITY, [{ op: 'addEdge', source: 'parse', target: 'db', kind, label }]);
    expect(add('arrow', 'batch')).toEqual({ ok: false, refusal: 'duplicate-edge', at: 0 });
    expect(add('arrow', null).ok).toBe(true);
    expect(add('dotted', 'batch').ok).toBe(true);
    expect(
      applyFlowEdits(FIDELITY, [
        { op: 'reconnectEdge', edge: 2, source: 'parse', target: 'enrich' },
      ]),
    ).toEqual({ ok: false, refusal: 'duplicate-edge', at: 0 });
  });

  it('<--> keeps written direction', () => {
    const r = applyFlowEdits('flowchart LR\n  a <--> b', [
      { op: 'relabelEdge', edge: 0, label: 'x' },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\n  a <-->|x| b');
    expect(r.ok && r.doc.graph.edges[0]).toMatchObject({ source: 'a', target: 'b', kind: 'bidir' });
  });

  it('encodeLabel round-trips literal `#quot;`', () => {
    expect(encodeLabel('plain words')).toBe('plain words');
    expect(encodeLabel('#quot;')).toBe('"#35;quot;"');
    for (const label of ['#quot;', 'he said "hi"', 'a|b', 'array[0]', '{x}', 'a <b> #1']) {
      const node = applyFlowEdits('flowchart LR\n  n', [{ op: 'renameNode', id: 'n', label }]);
      expect(node.ok && node.doc.graph.nodes[0].label).toBe(label);
      const edge = applyFlowEdits('flowchart LR\n  a --> b', [
        { op: 'relabelEdge', edge: 0, label },
      ]);
      expect(edge.ok && edge.doc.graph.edges[0].label).toBe(label);
    }
  });

  it('contradictory intents → conflict', () => {
    expect(
      applyFlowEdits(FIDELITY, [
        { op: 'relabelEdge', edge: 3, label: 'x' },
        { op: 'removeEdge', edge: 3 },
      ]),
    ).toEqual({ ok: false, refusal: 'conflict', at: 1 });
    expect(
      applyFlowEdits(FIDELITY, [
        { op: 'removeNode', id: 'db' },
        { op: 'renameNode', id: 'db', label: 'x' },
      ]),
    ).toEqual({ ok: false, refusal: 'conflict', at: 1 });
  });

  it('a node delete batched with its own edges is not a conflict', () => {
    const r = applyFlowEdits(FIDELITY, [
      { op: 'removeEdge', edge: 3 },
      { op: 'removeNode', id: 'db' },
    ]);
    expect(r.ok && r.source.includes('db')).toBe(false);
  });

  it('a no-op edit returns ok with the source unchanged', () => {
    for (const edit of [
      { op: 'relabelEdge', edge: 3, label: 'batch' },
      { op: 'renameNode', id: 'parse', label: 'Parse' },
      { op: 'setShape', id: 'db', shape: 'cylinder' },
      { op: 'moveToSubgraph', id: 'w1', subgraph: 'workers' },
    ] satisfies FlowEdit[]) {
      expect(applyFlowEdits(FIDELITY, [edit])).toMatchObject({ ok: true, source: FIDELITY });
    }
  });

  it('refuses unknown, invalid and taken ids', () => {
    expect(applyFlowEdits(FIDELITY, [{ op: 'removeNode', id: 'ghost' }])).toMatchObject({
      refusal: 'unknown-id',
    });
    expect(applyFlowEdits(FIDELITY, [{ op: 'removeEdge', edge: 6 }])).toMatchObject({
      refusal: 'unknown-id',
    });
    expect(
      applyFlowEdits(FIDELITY, [
        { op: 'addNode', id: 'not an id', label: 'x', shape: 'rect', parent: null },
      ]),
    ).toMatchObject({ refusal: 'invalid-id' });
    expect(
      applyFlowEdits(FIDELITY, [
        { op: 'addNode', id: 'end', label: 'x', shape: 'rect', parent: null },
      ]),
    ).toMatchObject({ refusal: 'invalid-id' });
    expect(
      applyFlowEdits(FIDELITY, [{ op: 'addSubgraph', id: 'w1', title: 'x', parent: null }]),
    ).toMatchObject({ refusal: 'id-taken' });
  });

  it('ids created earlier in the batch can be referenced later', () => {
    const r = applyFlowEdits('flowchart LR\n  a', [
      { op: 'addSubgraph', id: 'g', title: 'Group', parent: null },
      { op: 'addNode', id: 'n1', label: 'New', shape: 'round', parent: 'g' },
      { op: 'addEdge', source: 'a', target: 'n1', kind: 'arrow', label: null },
    ]);
    expect(r.ok && r.source).toBe(
      'flowchart LR\n  a\n  subgraph g [Group]\n    n1(New)\n  end\n  a --> n1',
    );
  });

  it('removeEdge whose statement held `b[Bee]` leaves `b[Bee]` standalone', () => {
    const r = applyFlowEdits('flowchart LR\n  a --> b[Bee]\n  b --> c', [
      { op: 'removeEdge', edge: 0 },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\n  a\n  b[Bee]\n  b --> c');
  });

  it('removeNode drops `style n`, trims `class a,n x` to `class a x`', () => {
    const r = applyFlowEdits(
      'flowchart LR\n  a --> n\n  style n fill:#f00\n  class a,n x\n  class n y\n  classDef x fill:#0f0\n  click n call cb()',
      [{ op: 'removeNode', id: 'n' }],
    );
    expect(r.ok && r.source).toBe('flowchart LR\n  a\n  class a x\n  classDef x fill:#0f0');
  });

  it('keeps CRLF and the absence of a trailing newline', () => {
    const r = applyFlowEdits('flowchart LR\r\n  a -- x --> b\r\n  b --> c', [
      { op: 'relabelEdge', edge: 0, label: 'y' },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\r\n  a -- y --> b\r\n  b --> c');
    const mixed = applyFlowEdits('flowchart LR\r\n  a --> b\n  b --> c\r\n  c --> d', [
      { op: 'relabelEdge', edge: 1, label: 'y' },
    ]);
    expect(mixed.ok && mixed.source).toBe('flowchart LR\r\n  a --> b\n  b -->|y| c\r\n  c --> d');
    const trailing = applyFlowEdits('flowchart LR\n  a\n', [
      { op: 'addNode', id: 'n1', label: 'n1', shape: 'rect', parent: null },
    ]);
    expect(trailing.ok && trailing.source).toBe('flowchart LR\n  a\n  n1\n');
  });
});

describe('applyFlowEdits — reconnect across subgraphs', () => {
  const parents = (r: ReturnType<typeof applyFlowEdits>) => {
    if (!r.ok) throw new Error(`refused: ${r.refusal}`);
    return Object.fromEntries(r.doc.graph.nodes.map((n) => [n.id, n.parent]));
  };

  it('a reconnect from inside a subgraph to a top-level node goes to the top level', () => {
    const r = applyFlowEdits('flowchart LR\n  subgraph S\n    a --> b\n  end\n  c', [
      { op: 'reconnectEdge', edge: 0, source: 'a', target: 'c' },
    ]);
    expect(parents(r)).toEqual({ a: 'S', b: 'S', c: null });
    expect(r.ok && r.source).toBe(
      'flowchart LR\n  subgraph S\n    a\n    b\n  end\n  c\n  a --> c',
    );
  });

  it('a reconnect from one subgraph to a node in another keeps both memberships', () => {
    const r = applyFlowEdits(
      'flowchart LR\n  subgraph S\n    a --> b\n  end\n  subgraph T\n    t\n  end',
      [{ op: 'reconnectEdge', edge: 0, source: 'a', target: 't' }],
    );
    expect(parents(r)).toEqual({ a: 'S', b: 'S', t: 'T' });
  });

  it('a top-level reconnect onto a node in a subgraph stays where it is', () => {
    const r = applyFlowEdits('flowchart LR\n  subgraph S\n    s\n  end\n  a --> b', [
      { op: 'reconnectEdge', edge: 0, source: 'a', target: 's' },
    ]);
    expect(parents(r)).toEqual({ s: 'S', a: null, b: null });
    expect(r.ok && r.source).toBe('flowchart LR\n  subgraph S\n    s\n  end\n  a --> s\n  b');
  });

  it('the fidelity corpus: w1 -.-> w2 reconnected to db', () => {
    const r = applyFlowEdits(FIDELITY, [
      { op: 'reconnectEdge', edge: 5, source: 'w1', target: 'db' },
    ]);
    expect(parents(r)).toMatchObject({ w1: 'workers', w2: 'workers', db: null });
  });
});

describe('applyFlowEdits — removeSubgraph follows mermaid membership', () => {
  it('a member also listed in a sibling goes to that sibling', () => {
    const r = applyFlowEdits(
      'flowchart LR\n  subgraph S\n    a\n  end\n  subgraph T\n    a --> b\n  end',
      [{ op: 'removeSubgraph', id: 'S' }],
    );
    if (!r.ok) throw new Error(r.refusal);
    expect(Object.fromEntries(r.doc.graph.nodes.map((n) => [n.id, n.parent]))).toEqual({
      a: 'T',
      b: 'T',
    });
  });
});

describe('applyFlowEdits — subgraph edits', () => {
  const TWO =
    'flowchart LR\n  subgraph s [S]\n    a --> b[Bee]\n  end\n  subgraph t [T]\n    c\n  end';

  it('moveToSubgraph appends at the end of the target scope', () => {
    const r = applyFlowEdits('flowchart LR\n  a[A]\n  subgraph s [S]\n    b\n  end\n  a --> b', [
      { op: 'moveToSubgraph', id: 'a', subgraph: 's' },
    ]);
    expect(r.ok && r.source).toBe(
      'flowchart LR\n  subgraph s [S]\n    b\n    a[A]\n  end\n  a --> b',
    );
    expect(r.ok && r.doc.graph.nodes.find((n) => n.id === 'a')?.parent).toBe('s');
  });

  it('move whose first mention is an edge in the old scope moves that edge to top level', () => {
    const r = applyFlowEdits(TWO, [{ op: 'moveToSubgraph', id: 'a', subgraph: 't' }]);
    // The relocated copy is bare: the label stays with the declaration left behind (QA Q1).
    expect(r.ok && r.source).toBe(
      'flowchart LR\n  subgraph s [S]\n    b[Bee]\n  end\n  subgraph t [T]\n    c\n    a\n  end\n  a --> b',
    );
  });

  it('a move leaves one label per node, and a later rename reaches it', () => {
    // t closes before s, so the edge listing d in t has to leave t for d to become s's.
    const src =
      'flowchart LR\n  subgraph t [T]\n    c[Gamma] --> d\n  end\n  subgraph s [S]\n    a\n  end';
    const moved = applyFlowEdits(src, [{ op: 'moveToSubgraph', id: 'd', subgraph: 's' }]);
    if (!moved.ok) throw new Error(moved.refusal);
    expect(moved.source).toBe(
      'flowchart LR\n  subgraph t [T]\n    c[Gamma]\n  end\n  subgraph s [S]\n    a\n    d\n  end\n  c --> d',
    );
    expect(moved.source.match(/Gamma/g)).toHaveLength(1);
    const renamed = applyFlowEdits(moved.source, [{ op: 'renameNode', id: 'c', label: 'Gamma2' }]);
    if (!renamed.ok) throw new Error(renamed.refusal);
    expect(renamed.source).not.toContain('Gamma]');
    expect(renamed.doc.graph.nodes.find((n) => n.id === 'c')?.label).toBe('Gamma2');
  });

  it('a move leaves alone a listing in a subgraph that closes after the target', () => {
    const src =
      'flowchart LR\n  subgraph t [T]\n    a\n  end\n  subgraph u [U]\n    x --> u1\n  end';
    const r = applyFlowEdits(src, [{ op: 'moveToSubgraph', id: 'x', subgraph: 't' }]);
    expect(r.ok && r.source).toBe(
      'flowchart LR\n  subgraph t [T]\n    a\n    x\n  end\n  subgraph u [U]\n    x --> u1\n  end',
    );
  });

  it('a rename rewrites every labelled mention, since mermaid draws the last', () => {
    const r = applyFlowEdits('flowchart LR\n  c[Gamma] --> d\n  e --> c(Gamma)', [
      { op: 'renameNode', id: 'c', label: 'New' },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\n  c[New] --> d\n  e --> c(New)');
  });

  it('the root guard refuses a subgraph move that would re-parent an untargeted node', () => {
    // x is listed in S and U; S closes first, so x is S's. Moving S's block into T, which closes
    // after U, would hand x to U.
    const src = [
      'flowchart LR',
      '  subgraph S',
      '    x',
      '  end',
      '  subgraph U',
      '    x --> u',
      '  end',
      '  subgraph T',
      '    t1',
      '  end',
    ].join('\n');
    expect(applyFlowEdits(src, [{ op: 'moveToSubgraph', id: 'S', subgraph: 'T' }])).toEqual({
      ok: false,
      refusal: 'unsupported',
      at: 0,
    });
  });

  it("the reviewer's backward subgraph move keeps x in S and y at the top", () => {
    const src =
      'flowchart LR\n  subgraph T\n    t1\n  end\n  x[Ex] --> y\n  subgraph S\n    x\n  end';
    const r = applyFlowEdits(src, [{ op: 'moveToSubgraph', id: 'S', subgraph: 'T' }]);
    if (!r.ok) throw new Error(r.refusal);
    const parents = Object.fromEntries(r.doc.graph.nodes.map((n) => [n.id, n.parent]));
    expect(parents).toEqual({ t1: 'T', x: 'S', y: null });
    expect(r.doc.graph.subgraphs.find((s) => s.id === 'S')?.parent).toBe('T');
  });

  it('labels starting with a slash are quoted', () => {
    const r = applyFlowEdits('flowchart LR\n  a', [
      { op: 'renameNode', id: 'a', label: '/api/users' },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\n  a["/api/users"]');
    expect(r.ok && r.doc.graph.nodes[0]).toMatchObject({ label: '/api/users', shape: 'rect' });
  });

  it('class lines written with spaces after commas are pruned too', () => {
    const r = applyFlowEdits('flowchart LR\n  a --> n\n  class a, n, b x\n  b', [
      { op: 'removeNode', id: 'n' },
    ]);
    expect(r.ok && r.source).toBe('flowchart LR\n  a\n  class a, b x\n  b');
  });

  it('moving a subgraph with pending additions is a conflict', () => {
    const src = 'flowchart LR\n  subgraph s [S]\n    a\n  end\n  subgraph t [T]\n    b\n  end';
    expect(
      applyFlowEdits(src, [
        { op: 'addNode', id: 'n1', label: 'n1', shape: 'rect', parent: 's' },
        { op: 'moveToSubgraph', id: 's', subgraph: 't' },
      ]),
    ).toEqual({ ok: false, refusal: 'conflict', at: 1 });
  });

  it('membership move of an edge statement re-declares the other endpoint in the old scope when the edge was its first mention', () => {
    const r = applyFlowEdits(TWO, [{ op: 'moveToSubgraph', id: 'a', subgraph: 't' }]);
    if (!r.ok) throw new Error(r.refusal);
    const parents = Object.fromEntries(r.doc.graph.nodes.map((n) => [n.id, [n.parent, n.label]]));
    expect(parents).toEqual({ a: ['t', 'a'], b: ['s', 'Bee'], c: ['t', 'c'] });
  });

  it('subgraph into its descendant → cycle', () => {
    const nested =
      'flowchart LR\n  subgraph outer [Outer]\n    subgraph inner [Inner]\n      x\n    end\n  end';
    expect(
      applyFlowEdits(nested, [{ op: 'moveToSubgraph', id: 'outer', subgraph: 'inner' }]),
    ).toEqual({ ok: false, refusal: 'cycle', at: 0 });
    expect(
      applyFlowEdits(nested, [{ op: 'moveToSubgraph', id: 'outer', subgraph: 'outer' }]),
    ).toEqual({ ok: false, refusal: 'cycle', at: 0 });
    const lifted = applyFlowEdits(nested, [{ op: 'moveToSubgraph', id: 'inner', subgraph: null }]);
    expect(lifted.ok && lifted.doc.graph.subgraphs.map((s) => [s.id, s.parent])).toEqual([
      ['outer', null],
      ['inner', null],
    ]);
  });
});

describe('nextNodeId', () => {
  it('skips taken ids', () => {
    const parsed = parseFlowchart('flowchart LR\nsubgraph n2 [Two]\n  n1[One]\nend\nn4[Four]\n');
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(nextNodeId(parsed.doc.graph, 'n')).toBe('n3');
    expect(nextNodeId(parsed.doc.graph, 'svc')).toBe('svc1');
  });
});
