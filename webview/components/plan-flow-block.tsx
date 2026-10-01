import { useNodeViewContext } from '@prosemirror-adapter/react';
import { useCallback, useContext, useRef, useState } from 'react';
import { parseFlowchart } from '../../src/mermaid-flow';
import type { FlowEdit } from '../../src/mermaid-flow-edit';
import {
  diagramKeyAt,
  writeDiagram,
  writeDiagramText,
  writeFenceTextAt,
} from '../plan-diagram-write';
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
 * escape hatch. The fence text is the only state, and every write finds the fence afresh — see
 * `plan-diagram-write.ts`.
 */
export function PlanFlowBlock() {
  const { node, view, getPos } = useNodeViewContext();
  const { readOnly } = useContext(PlanDocContext);
  const [asSource, setAsSource] = useState(false);
  const source = node.textContent;
  const at = getPos();
  const key = at === undefined ? null : diagramKeyAt(view.state.doc, at);

  const onEdits = useCallback(
    (edits: readonly FlowEdit[]) => (key === null ? 'gone' : writeDiagram(view, key, edits)),
    [view, key],
  );

  const writeText = useCallback(
    (text: string) => {
      if (key !== null) {
        writeDiagramText(view, key, text);
        return;
      }
      const pos = getPos();
      if (pos !== undefined) writeFenceTextAt(view, pos, text);
    },
    [view, key, getPos],
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
        graph={parsed.doc.graph}
        onEdits={onEdits}
        readOnly={readOnly}
        onEditAsText={() => setAsSource(true)}
        onLeave={onLeave}
      />
    </div>
  );
}
