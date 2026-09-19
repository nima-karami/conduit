import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  type FlowGraph,
  moveToSubgraph,
  nextNodeId,
  parseFlowchart,
  relabelEdge,
  removeEdge,
  removeNode,
  serializeFlowchart,
} from '../../src/mermaid-flow';

const FIXTURE = path.join(__dirname, '..', 'e2e', 'fixtures', 'plan', 'identity.md');

function fixtureDiagram(): string {
  const md = fs.readFileSync(FIXTURE, 'utf8');
  const fence = /```mermaid\r?\n([\s\S]*?)```/.exec(md);
  if (!fence) throw new Error('no mermaid fence in the fixture');
  return fence[1];
}

function graphOf(source: string): FlowGraph {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) throw new Error(`${parsed.reason} (line ${parsed.line})`);
  return parsed.graph;
}

const NESTED = [
  'flowchart TB',
  '  subgraph outer [Outer group]',
  '    a([Start])',
  '    subgraph inner [Inner]',
  '      b{Decide}',
  '      c((Done))',
  '    end',
  '  end',
  '  d[[Worker]]',
  '  e(Plain)',
  '  a --> b',
  '  b -.->|no| c',
  '  b ==> d',
  '  d <--> e',
  '  e --- a',
  '',
].join('\n');

const TRAILER = [
  'flowchart LR',
  '  %% styling lives below the graph',
  '  a -- retry --> b',
  '  classDef hot fill:#f00',
  '  class a hot',
  '  linkStyle 0 stroke:#0f0',
  '',
].join('\n');

describe('parseFlowchart', () => {
  it('parses the fixture diagram into 3 nodes, 1 subgraph, 3 edges with the labelled edge', () => {
    const g = graphOf(fixtureDiagram());

    expect(g.keyword).toBe('flowchart');
    expect(g.direction).toBe('LR');
    expect(g.subgraphs).toEqual([{ id: 'backend', title: 'Backend', parent: null }]);
    expect(g.nodes).toEqual([
      { id: 'identity', label: 'Identity service', shape: 'rect', parent: 'backend' },
      { id: 'txn', label: 'Transaction service', shape: 'rect', parent: 'backend' },
      { id: 'web', label: 'Web app', shape: 'rect', parent: null },
    ]);
    expect(g.edges).toEqual([
      { source: 'web', target: 'identity', kind: 'arrow', label: null },
      { source: 'web', target: 'txn', kind: 'arrow', label: null },
      { source: 'txn', target: 'identity', kind: 'arrow', label: 'lookup' },
    ]);
    expect(g.trailer).toEqual([]);
  });

  it('parse → serialize → parse is deep-equal', () => {
    for (const source of [fixtureDiagram(), NESTED, TRAILER]) {
      const once = graphOf(source);
      const twice = graphOf(serializeFlowchart(once));
      // A parser that dropped every line would round-trip vacuously.
      expect(once.nodes.length + once.edges.length + once.trailer.length).toBeGreaterThan(4);
      expect(twice).toEqual(once);
    }
  });

  it('unsupported syntax reports the line', () => {
    expect(parseFlowchart('flowchart LR\na & b --> c\n')).toMatchObject({ ok: false, line: 2 });
    expect(parseFlowchart('flowchart LR\na --> b\na:::hot\n')).toMatchObject({
      ok: false,
      line: 3,
    });
    expect(parseFlowchart('flowchart LR\na ~~~ b\n')).toMatchObject({ ok: false, line: 2 });
    expect(parseFlowchart('flowchart LR\na -->|x|b\n')).toMatchObject({ ok: false, line: 2 });
  });
});

describe('serializeFlowchart', () => {
  it('serialize is canonical', () => {
    expect(serializeFlowchart(graphOf(fixtureDiagram()))).toBe(
      [
        'flowchart LR',
        'subgraph backend [Backend]',
        '  identity[Identity service]',
        '  txn[Transaction service]',
        'end',
        'web[Web app]',
        'web --> identity',
        'web --> txn',
        'txn -->|lookup| identity',
        '',
      ].join('\n'),
    );
  });

  it('labels with brackets are quoted on serialize', () => {
    const g = addNode(graphOf('flowchart LR\n'), 'n1', 'array[0]');
    expect(serializeFlowchart(g)).toBe('flowchart LR\nn1["array[0]"]\n');
    expect(graphOf(serializeFlowchart(g)).nodes[0].label).toBe('array[0]');
  });

  it('a label containing a quote round-trips', () => {
    const g = addNode(graphOf('flowchart LR\n'), 'n1', 'he said "hi"');
    const text = serializeFlowchart(g);

    expect(text).toContain('#quot;');
    expect(graphOf(text)).toEqual(g);
  });
});

describe('reducers', () => {
  it('removeEdge by index drops exactly that edge', () => {
    const g = graphOf(fixtureDiagram());
    const next = removeEdge(g, 1);

    expect(next.edges).toEqual([
      { source: 'web', target: 'identity', kind: 'arrow', label: null },
      { source: 'txn', target: 'identity', kind: 'arrow', label: 'lookup' },
    ]);
    expect(next.nodes).toEqual(g.nodes);
    expect(removeEdge(g, 3)).toBe(g);
  });

  it('removeNode drops incident edges', () => {
    const g = graphOf(fixtureDiagram());
    const next = removeNode(g, 'txn');

    expect(next.nodes.map((n) => n.id)).toEqual(['identity', 'web']);
    expect(next.edges).toEqual([{ source: 'web', target: 'identity', kind: 'arrow', label: null }]);
    expect(removeNode(g, 'nope')).toBe(g);
  });

  it('addEdge duplicate is a no-op returning the same reference', () => {
    const g = graphOf(fixtureDiagram());
    const once = addEdge(g, 'identity', 'web');

    expect(once.edges).toHaveLength(4);
    expect(once.edges[3]).toEqual({
      source: 'identity',
      target: 'web',
      kind: 'arrow',
      label: null,
    });
    expect(addEdge(once, 'identity', 'web')).toBe(once);
    expect(addEdge(once, 'identity', 'ghost')).toBe(once);
    expect(relabelEdge(once, 3, 'sso').edges[3].label).toBe('sso');
  });

  it('moveToSubgraph into a descendant is refused', () => {
    const g = graphOf(NESTED);

    expect(moveToSubgraph(g, 'outer', 'inner')).toBe(g);
    expect(moveToSubgraph(g, 'outer', 'outer')).toBe(g);
    expect(moveToSubgraph(g, 'd', 'ghost')).toBe(g);

    const moved = moveToSubgraph(g, 'd', 'inner');
    expect(moved.nodes.find((n) => n.id === 'd')?.parent).toBe('inner');
    expect(moveToSubgraph(moved, 'inner', null).subgraphs).toEqual([
      { id: 'outer', title: 'Outer group', parent: null },
      { id: 'inner', title: 'Inner', parent: null },
    ]);
  });

  it('nextNodeId skips taken ids', () => {
    const g = graphOf('flowchart LR\nsubgraph n2 [Two]\n  n1[One]\nend\nn4[Four]\n');

    expect(nextNodeId(g, 'n')).toBe('n3');
    expect(nextNodeId(addNode(g, 'n3', 'Three'), 'n')).toBe('n5');
    expect(nextNodeId(g, 'svc')).toBe('svc1');
  });
});
