import { describe, expect, it } from 'vitest';
import { flowDiagramKeys } from '../../src/flow-diagram-key';

const mermaid = (text: string) => ({ language: 'mermaid', text });

describe('flowDiagramKeys', () => {
  it('counts unparsable flowcharts', () => {
    expect(
      flowDiagramKeys([
        mermaid('flowchart LR\na --> b'),
        mermaid('flowchart LR\na & b --> c'),
        mermaid('graph TD\nx'),
      ]),
    ).toEqual(['flow-0', 'flow-1', 'flow-2']);
  });

  it('skips sequence diagrams and `%%`-led non-flowcharts', () => {
    expect(
      flowDiagramKeys([
        mermaid('sequenceDiagram\nA->>B: hi'),
        mermaid('%%{init: {}}%%\n\nsequenceDiagram\nA->>B: hi'),
        mermaid('%% a flowchart, after a comment\n\n  flowchart LR\na'),
        mermaid('graphql-ish\nnope'),
      ]),
    ).toEqual([null, null, 'flow-0', null]);
  });

  it('non-mermaid fences → null', () => {
    expect(
      flowDiagramKeys([
        { language: 'ts', text: 'flowchart LR' },
        mermaid('flowchart LR'),
        { language: '', text: 'graph TD' },
      ]),
    ).toEqual([null, 'flow-0', null]);
  });
});
