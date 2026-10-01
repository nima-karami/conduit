import { redo, undo } from '@milkdown/kit/prose/history';
import { useNodeViewContext } from '@prosemirror-adapter/react';
import { type KeyboardEvent, useCallback, useContext, useMemo, useRef, useState } from 'react';
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

  // ProseMirror keeps an unchanged node view without calling update(), so nothing rendered here can
  // be trusted to still name this fence: the key is read from the document at call time.
  const keyNow = useCallback((): string | null => {
    const pos = getPos();
    return pos === undefined ? null : diagramKeyAt(view.state.doc, pos);
  }, [view, getPos]);

  // `source` is what the edits were computed against; writeDiagram refuses a fence that has moved on.
  const onEdits = useCallback(
    (edits: readonly FlowEdit[]) => {
      const key = keyNow();
      return key === null ? 'gone' : writeDiagram(view, key, edits, source);
    },
    [view, keyNow, source],
  );

  const writeText = useCallback(
    (text: string) => {
      const key = keyNow();
      if (key !== null) {
        writeDiagramText(view, key, text);
        return;
      }
      const pos = getPos();
      if (pos !== undefined) writeFenceTextAt(view, pos, text);
    },
    [view, keyNow, getPos],
  );

  const onLeave = useCallback(() => leaveBlock(view, getPos, node), [view, getPos, node]);

  const parsed = useMemo(() => parseFlowchart(source), [source]);

  const onUndoKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || target.closest('input, textarea')) return;
      const key = e.key.toLowerCase();
      const command = key === 'z' ? (e.shiftKey ? redo : undo) : key === 'y' ? redo : null;
      if (!command) return;
      // Claimed even when read-only: let through, it reaches the app-wide undo of file operations.
      e.preventDefault();
      if (!readOnly) command(view.state, view.dispatch);
    },
    [view, readOnly],
  );

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
    // The node view stops every event from reaching ProseMirror, its undo keymap included, so the
    // canvas forwards undo/redo itself; an inline input keeps its own (decision #5 hands canvas undo
    // to the document's history).
    <div className="planflow" role="group" aria-label="Diagram block" onKeyDown={onUndoKey}>
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
