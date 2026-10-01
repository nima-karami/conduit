// @vitest-environment jsdom
import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/mermaid-flow';

/**
 * The parser's membership and labels must be mermaid's own, not a reading of the docs: every case
 * is parsed by mermaid's flowchart parser too and its `getData()` parents and vertex texts compared.
 */
interface MermaidData {
  nodes: { id: string; parentId?: string; label?: string; isGroup?: boolean }[];
}

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false });
});

async function mermaidView(source: string): Promise<Record<string, [string | null, string]>> {
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  const data = (diagram.db as unknown as { getData(): MermaidData }).getData();
  return Object.fromEntries(
    data.nodes.map((n) => [n.id, [n.parentId ?? null, n.label ?? ''] as [string | null, string]]),
  );
}

function ourView(source: string): Record<string, [string | null, string]> {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) throw new Error(parsed.reason);
  const { nodes, subgraphs } = parsed.doc.graph;
  return Object.fromEntries([
    ...nodes.map((n): [string, [string | null, string]] => [n.id, [n.parent, n.label]]),
    ...subgraphs.map((s): [string, [string | null, string]] => [s.id, [s.parent, s.title]]),
  ]);
}

const CASES: [name: string, source: string][] = [
  [
    'a top-level mention before the subgraph confers nothing',
    'flowchart LR\n  a --> b\n  subgraph S\n    a\n  end',
  ],
  [
    'an edge endpoint inside a body is a member',
    'flowchart LR\n  x\n  subgraph S\n    a --> x\n  end',
  ],
  [
    'listed in two siblings: the earliest-closed wins',
    'flowchart LR\n  subgraph S\n    a\n  end\n  subgraph T\n    a --> c\n  end',
  ],
  [
    'listed in a parent and its child: the child closes first',
    'flowchart LR\n  subgraph O\n    a\n    subgraph I\n      a --> b\n    end\n  end',
  ],
  [
    'a subgraph moved after a top-level edge keeps its members',
    'flowchart LR\n  subgraph T\n    t1\n    subgraph S\n      x\n    end\n  end\n  x[Ex] --> y',
  ],
  ['the last label wins', 'flowchart LR\n  a[First] --> b\n  a[Second]'],
  [
    'the fidelity corpus',
    'flowchart LR\n    src[Source] --> parse[Parse] --> enrich(Enrich) --> sink\n    parse -- batch --> db[(Store)]\n    subgraph workers [Workers]\n        w1[Worker one]\n        w2{{Worker two}}\n    end\n    enrich --> w1\n    w1 -.-> w2',
  ],
];

describe('membership and labels match mermaid', () => {
  it.each(CASES)('%s', async (_name, source) => {
    expect(ourView(source)).toEqual(await mermaidView(source));
  });
});
