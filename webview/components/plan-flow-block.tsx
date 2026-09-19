import { useNodeViewContext } from '@prosemirror-adapter/react';
import { useCallback, useContext, useRef, useState } from 'react';
import { parseFlowchart, serializeFlowchart } from '../../src/mermaid-flow';
import { useDebouncedFlush } from '../use-debounced-flush';
import { FlowEditor } from './flow-editor';
import { MermaidDiagram } from './mermaid-diagram';
import { leaveBlock, PlanDocContext } from './plan-code-block';

const SOURCE_DEBOUNCE_MS = 150;

function SourceEditor({
  initial,
  readOnly,
  onText,
  onDone,
}: {
  initial: string;
  readOnly: boolean;
  onText: (text: string) => void;
  onDone: () => void;
}) {
  const [text, setText] = useState(initial);
  const textRef = useRef(initial);
  const { schedule } = useDebouncedFlush(() => onText(textRef.current), SOURCE_DEBOUNCE_MS);
  return (
    <>
      <div className="planflow__toolbar">
        <button type="button" className="planflow__button" onClick={onDone}>
          View diagram
        </button>
      </div>
      <textarea
        className="planflow__source"
        aria-label="Diagram source"
        spellCheck={false}
        readOnly={readOnly}
        value={text}
        onChange={(e) => {
          textRef.current = e.target.value;
          setText(e.target.value);
          schedule();
        }}
      />
    </>
  );
}

/**
 * Node view for a `mermaid` fence: a structural editor when the flowchart is inside the
 * round-trippable subset (`src/mermaid-flow.ts`), otherwise a rendered preview plus a plain-text
 * escape hatch. The fence text is the only state — see the plan, Settled decisions.
 */
export function PlanFlowBlock() {
  const { node, view, getPos } = useNodeViewContext();
  const { readOnly } = useContext(PlanDocContext);
  const [asSource, setAsSource] = useState(false);
  const source = node.textContent;

  const writeText = useCallback(
    (text: string) => {
      const pos = getPos();
      if (pos === undefined || text === node.textContent) return;
      const tr = view.state.tr;
      const from = pos + 1;
      const to = pos + node.nodeSize - 1;
      // An empty ProseMirror text node is illegal, so clearing the fence is a delete.
      view.dispatch(
        text ? tr.replaceWith(from, to, view.state.schema.text(text)) : tr.delete(from, to),
      );
    },
    [getPos, node, view],
  );

  // serializeFlowchart terminates the graph with a newline; a fence's text node does not carry
  // one, and keeping it would add a blank line to the fence on every write.
  const writeGraph = useCallback(
    (text: string) => writeText(text.replace(/\n+$/, '')),
    [writeText],
  );

  const onLeave = useCallback(() => leaveBlock(view, getPos, node), [view, getPos, node]);

  const parsed = parseFlowchart(source);

  if (asSource) {
    return (
      <div className="planflow" role="group" aria-label="Diagram block">
        <SourceEditor
          initial={source}
          readOnly={readOnly}
          onText={writeText}
          onDone={() => setAsSource(false)}
        />
      </div>
    );
  }

  if (!parsed.ok) {
    return (
      <div className="planflow" role="group" aria-label="Diagram block">
        <div className="planflow__toolbar">
          <button type="button" className="planflow__button" onClick={() => setAsSource(true)}>
            Edit as text
          </button>
        </div>
        <p className="planflow__unsupported">
          This diagram uses syntax the editor can't round-trip: {parsed.reason}
        </p>
        <MermaidDiagram source={source} />
      </div>
    );
  }

  return (
    <div className="planflow" role="group" aria-label="Diagram block">
      <FlowEditor
        graph={parsed.graph}
        onGraph={(g) => writeGraph(serializeFlowchart(g))}
        readOnly={readOnly}
        onEditAsText={() => setAsSource(true)}
        onLeave={onLeave}
      />
    </div>
  );
}
