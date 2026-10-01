import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type FlowDoc, parseFlowchart } from '../../src/mermaid-flow';

const FIXTURE = path.join(__dirname, '..', 'e2e', 'fixtures', 'plan', 'identity.md');

function fixtureDiagram(): string {
  const md = fs.readFileSync(FIXTURE, 'utf8');
  const fence = /```mermaid\r?\n([\s\S]*?)```/.exec(md);
  if (!fence) throw new Error('no mermaid fence in the fixture');
  return fence[1];
}

function docOf(source: string): FlowDoc {
  const parsed = parseFlowchart(source);
  if (!parsed.ok) throw new Error(`${parsed.reason} (line ${parsed.line})`);
  return parsed.doc;
}

const textAt = (doc: FlowDoc, s: { line: number; start: number; end: number }): string =>
  doc.lines[s.line].slice(s.start, s.end);

describe('parseFlowchart', () => {
  it('parses the fixture diagram into 3 nodes, 1 subgraph, 3 edges with the labelled edge', () => {
    const { graph: g } = docOf(fixtureDiagram());

    expect(g.keyword).toBe('flowchart');
    expect(g.direction).toBe('LR');
    expect(g.subgraphs).toEqual([
      { id: 'backend', title: 'Backend', parent: null, open: 1, close: 4 },
    ]);
    expect(g.nodes.map((n) => [n.id, n.label, n.shape, n.parent])).toEqual([
      ['identity', 'Identity service', 'rect', 'backend'],
      ['txn', 'Transaction service', 'rect', 'backend'],
      ['web', 'Web app', 'rect', null],
    ]);
    expect(g.edges.map((e) => [e.source, e.target, e.kind, e.label])).toEqual([
      ['web', 'identity', 'arrow', null],
      ['web', 'txn', 'arrow', null],
      ['txn', 'identity', 'arrow', 'lookup'],
    ]);
  });

  it('records statement line, indent, eol', () => {
    const doc = docOf('flowchart LR\n    a --> b\n  subgraph s [S]\n\tc\n  end\n');

    expect(doc.eol).toBe('\n');
    expect(doc.lines).toEqual([
      'flowchart LR',
      '    a --> b',
      '  subgraph s [S]',
      '\tc',
      '  end',
      '',
    ]);
    expect(doc.statements.map((s) => [s.kind, s.line, s.indent, s.scope])).toEqual([
      ['header', 0, '', null],
      ['chain', 1, '    ', null],
      ['subgraph', 2, '  ', null],
      ['chain', 3, '\t', 's'],
      ['end', 4, '  ', null],
      ['blank', 5, '', null],
    ]);
  });

  it('chain refs/links spans', () => {
    const doc = docOf('flowchart LR\n  a --> b -- x --> c\n');
    const chain = doc.statements[1];

    expect(chain.refs).toHaveLength(3);
    expect(chain.links).toHaveLength(2);
    expect(chain.refs.map((s) => textAt(doc, s))).toEqual(['a', 'b', 'c']);
    expect(chain.links.map((s) => textAt(doc, s))).toEqual(['-->', '-- x -->']);
    expect(doc.graph.edges[1]).toMatchObject({
      source: 'b',
      target: 'c',
      label: 'x',
      stmt: 1,
      link: 1,
    });
    expect(doc.graph.edges[0]).toMatchObject({ stmt: 1, link: 0 });
  });

  it('%% and blank lines are statements', () => {
    const doc = docOf('%% lead\nflowchart TD\n\n  %% note\n  a\n');

    expect(doc.statements.map((s) => s.kind)).toEqual([
      'comment',
      'header',
      'blank',
      'comment',
      'chain',
      'blank',
    ]);
  });

  it('def is the first mention with a label; the label is the last one, as mermaid draws it', () => {
    const doc = docOf('flowchart LR\na --> b\nb[Bee]\nb(Later)\n');
    const b = doc.graph.nodes.find((n) => n.id === 'b');

    expect(b?.label).toBe('Later');
    expect(b?.shape).toBe('round');
    expect(b?.def.line).toBe(2);
    expect(b?.first.line).toBe(1);
    expect(textAt(doc, b?.def ?? { line: 0, start: 0, end: 0 })).toBe('b[Bee]');
    const a = doc.graph.nodes.find((n) => n.id === 'a');
    expect(a?.def).toEqual(a?.first);
  });

  it('cylinder/hexagon parse', () => {
    const { graph } = docOf('flowchart LR\ndb[(Store)] --> h{{Hex}}\nr[Rect]\n');

    expect(graph.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([
      ['db', 'cylinder', 'Store'],
      ['h', 'hexagon', 'Hex'],
      ['r', 'rect', 'Rect'],
    ]);
  });

  it('verbatim bracket forms parse', () => {
    const doc = docOf(
      'flowchart LR\nn>Flag] --> p[/Para/]\nq[\\Back\\] --> t[/Trap\\]\nu[\\Inv/] --> v[Plain]\n',
    );

    expect(doc.graph.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([
      ['n', 'verbatim', 'Flag'],
      ['p', 'verbatim', 'Para'],
      ['q', 'verbatim', 'Back'],
      ['t', 'verbatim', 'Trap'],
      ['u', 'verbatim', 'Inv'],
      ['v', 'rect', 'Plain'],
    ]);
    const t = doc.graph.nodes.find((n) => n.id === 't');
    expect(textAt(doc, t?.def ?? { line: 0, start: 0, end: 0 })).toBe('t[/Trap\\]');
  });

  it('decodes #quot; and #35;', () => {
    const { graph } = docOf('flowchart LR\na["say #quot;hi#quot;"] -->|"#35;1"| b["#35;quot;"]\n');

    expect(graph.nodes[0].label).toBe('say "hi"');
    expect(graph.edges[0].label).toBe('#1');
    expect(graph.nodes[1].label).toBe('#quot;');
  });

  it('trailer lines are statements', () => {
    const doc = docOf(
      'flowchart LR\n  a -- retry --> b\n  classDef hot fill:#f00\n  class a hot\n  linkStyle 0 stroke:#0f0\n',
    );

    expect(doc.statements.map((s) => s.kind)).toEqual([
      'header',
      'chain',
      'trailer',
      'trailer',
      'trailer',
      'blank',
    ]);
  });

  it('CRLF source parses with eol \\r\\n', () => {
    const doc = docOf('flowchart LR\r\n  a --> b\r\n');

    expect(doc.eol).toBe('\r\n');
    expect(doc.lines).toEqual(['flowchart LR', '  a --> b', '']);
    expect(doc.graph.edges).toHaveLength(1);
  });

  it('unsupported syntax reports the line', () => {
    expect(parseFlowchart('flowchart LR\na & b --> c\n')).toMatchObject({
      ok: false,
      reason: 'unsupported syntax',
      line: 2,
    });
    expect(parseFlowchart('flowchart LR\na --> b\na:::hot\n')).toMatchObject({
      ok: false,
      line: 3,
    });
    expect(parseFlowchart('flowchart LR\na ~~~ b\n')).toMatchObject({ ok: false, line: 2 });
    expect(parseFlowchart('flowchart LR\na -->|x|b\n')).toMatchObject({ ok: false, line: 2 });
    expect(parseFlowchart('sequenceDiagram\n')).toMatchObject({
      ok: false,
      reason: 'expected a flowchart or graph header',
      line: 1,
    });
    expect(parseFlowchart('flowchart LR\nend\n')).toMatchObject({
      ok: false,
      reason: 'end without an open subgraph',
      line: 2,
    });
    expect(parseFlowchart('flowchart LR\nsubgraph s\na\n')).toMatchObject({
      ok: false,
      reason: 'unclosed subgraph',
      line: 2,
    });
    expect(parseFlowchart('flowchart LR\na\nsubgraph a\nend\n')).toMatchObject({
      ok: false,
      reason: 'duplicate id',
      line: 3,
    });
  });
});
