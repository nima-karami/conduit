import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { langFromPath } from '../../src/lang';
import type { FileDiffDTO } from '../../src/protocol';
import { OVERVIEW_RULER_WIDTH } from '../change-decorations';
import { nextChange, prevChange } from '../diff-nav';
import { ensureTokenizer } from '../monaco-languages';
import { monacoOverflowHost } from '../monaco-overflow-host';
import { ensureTheme } from '../monaco-theme';
import { useSettings } from '../settings';
import { makeDebouncedFlush } from '../use-debounced-flush';
import { getViewState, setViewState, VIEW_STATE_DEBOUNCE_MS } from '../view-state-store';
import { DiffControlsBar } from './diff-controls-bar';
import { ImageDiff } from './image-diff';

export function DiffViewer({
  doc,
  viewStateId,
  onOpenFile,
  initialSideBySide,
  onSideBySideToggled,
  showWhitespace = false,
}: {
  doc: FileDiffDTO;
  viewStateId?: string;
  onOpenFile?: (path: string) => void;
  initialSideBySide?: boolean;
  onSideBySideToggled?: () => void;
  /** Mark whitespace-only changes too (Monaco hides them by default). */
  showWhitespace?: boolean;
}) {
  if (doc.oversize) return <OversizeNotice doc={doc} onOpenFile={onOpenFile} />;
  if (doc.image) return <ImageDiff doc={doc} />;
  return (
    <TextDiffViewer
      doc={doc}
      viewStateId={viewStateId}
      initialSideBySide={initialSideBySide}
      onSideBySideToggled={onSideBySideToggled}
      showWhitespace={showWhitespace}
    />
  );
}

/** Placeholder shown when a file exceeds the 2 MB diff cap: the content is never read/shipped, so a
 *  huge file can't freeze or mislead. An optional escape hatch opens the file in the capped viewer. */
function OversizeNotice({
  doc,
  onOpenFile,
}: {
  doc: FileDiffDTO;
  onOpenFile?: (path: string) => void;
}) {
  const mb = ((doc.oversize?.bytes ?? 0) / (1024 * 1024)).toFixed(1);
  return (
    <div className="viewer__notice viewer__notice--oversize">
      <div>This file is too large to diff ({mb} MB).</div>
      {onOpenFile && (
        <button
          type="button"
          className="viewer__notice-action"
          onClick={() => onOpenFile(doc.path)}
        >
          Open file
        </button>
      )}
    </div>
  );
}

function TextDiffViewer({
  doc,
  viewStateId,
  initialSideBySide,
  onSideBySideToggled,
  showWhitespace,
}: {
  doc: FileDiffDTO;
  viewStateId?: string;
  initialSideBySide?: boolean;
  onSideBySideToggled?: () => void;
  showWhitespace: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The editor is built once per path and a refresh swaps the text in place (below), so the
  // creation effect reads the text through refs rather than depending on it — rebuilding on
  // every refresh loses the cursor and flashes (spec 2026-09-22-scoped-diff-tabs §3).
  const headRef = useRef(doc.head);
  headRef.current = doc.head;
  const workRef = useRef(doc.work);
  workRef.current = doc.work;
  const showWhitespaceRef = useRef(showWhitespace);
  showWhitespaceRef.current = showWhitespace;
  const editorRef = useRef<monaco.editor.IDiffEditor | null>(null);
  const { settings, update } = useSettings();
  const [hasChanges, setHasChanges] = useState(false);
  // Reflects what is actually PAINTED, not the setting: a card's "Open side-by-side" seeds this
  // editor with an override the global setting never sees (spec 2026-09-05-review-mode §2.5).
  const [sideBySide, setSideBySide] = useState(initialSideBySide ?? settings.diffSideBySide);
  // Mirrors what is actually PAINTED, so a recreate of the editor restores it; never re-derived
  // from `initialSideBySide`, which would pin the tab to the override instead.
  const renderSideBySideRef = useRef(sideBySide);
  renderSideBySideRef.current = sideBySide;

  useEffect(() => {
    if (!ref.current || doc.binary) return;
    const theme = ensureTheme();
    const language = langFromPath(doc.path);
    ensureTokenizer(language);
    const editor = monaco.editor.createDiffEditor(ref.current, {
      theme,
      readOnly: true,
      automaticLayout: true,
      overflowWidgetsDomNode: monacoOverflowHost(),
      fixedOverflowWidgets: true,
      renderSideBySide: renderSideBySideRef.current,
      // Monaco defaults this to true, which silently overrides renderSideBySide below the
      // 900px breakpoint. False means the user's toggle is always respected.
      useInlineViewWhenSpaceIsLimited: false,
      // NO minimap option: monaco's diff widget forces `minimap.enabled = false` on both panes
      // unconditionally (`diffEditorEditors.js` `_adjustOptionsForSubEditor`), because its own
      // whole-file diff overview ruler occupies that space. Passing one would be dead code; the
      // diff overview IS the map here. See spec 2026-08-31-review-fidelity §6 / the run report.
      // Stated rather than inherited: this ruler is the whole point of the item, and monaco's
      // default is not a contract.
      renderOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: OVERVIEW_RULER_WIDTH },
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      ignoreTrimWhitespace: !showWhitespaceRef.current,
    });
    editor.setModel({
      original: monaco.editor.createModel(headRef.current, language),
      modified: monaco.editor.createModel(workRef.current, language),
    });
    editorRef.current = editor;

    // The diff is computed asynchronously, so a read right after setModel sees no changes yet.
    const diffSub = editor.onDidUpdateDiff(() =>
      setHasChanges((editor.getLineChanges()?.length ?? 0) > 0),
    );

    // Per-tab scroll memory (spec 2026-06-30): px scrollTop on the modified side. Restore after
    // setModel (content height is known) and capture debounced + a sync final capture on teardown.
    const modified = editor.getModifiedEditor();
    if (viewStateId) {
      const saved = getViewState(viewStateId);
      if (saved?.kind === 'scroll') modified.setScrollTop(saved.top);
    }
    const captureScroll = () => {
      if (viewStateId) setViewState(viewStateId, { kind: 'scroll', top: modified.getScrollTop() });
    };
    const debounced = makeDebouncedFlush(captureScroll, VIEW_STATE_DEBOUNCE_MS);
    const scrollSub = viewStateId ? modified.onDidScrollChange(() => debounced.schedule()) : null;

    return () => {
      debounced.cancel();
      captureScroll();
      scrollSub?.dispose();
      diffSub.dispose();
      const m = editor.getModel();
      m?.original.dispose();
      m?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [doc.path, doc.binary, viewStateId]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const modified = editor.getModifiedEditor();
    const viewState = modified.saveViewState();
    if (model.original.getValue() !== doc.head) model.original.setValue(doc.head);
    if (model.modified.getValue() !== doc.work) model.modified.setValue(doc.work);
    // Monaco clamps a restored position to the new line count.
    if (viewState) modified.restoreViewState(viewState);
  }, [doc.head, doc.work]);

  // Apply renderSideBySide changes live (see useInlineViewWhenSpaceIsLimited note above). Skips
  // its first run: that value already reached the editor via renderSideBySideRef above,
  // and applying the global setting here on mount would stomp a one-time override immediately.
  const firstApplyRef = useRef(true);
  useEffect(() => {
    if (firstApplyRef.current) {
      firstApplyRef.current = false;
      return;
    }
    editorRef.current?.updateOptions({
      renderSideBySide: settings.diffSideBySide,
      useInlineViewWhenSpaceIsLimited: false,
    });
    setSideBySide(settings.diffSideBySide);
  }, [settings.diffSideBySide]);

  const handleToggleSideBySide = () => {
    // Applied directly (not left to the settings-change effect): when an override is live,
    // the new value can equal the CURRENT global setting, which would otherwise fire no change
    // and leave this tab's editor stuck on the override.
    const next = !sideBySide;
    editorRef.current?.updateOptions({
      renderSideBySide: next,
      useInlineViewWhenSpaceIsLimited: false,
    });
    setSideBySide(next);
    update({ diffSideBySide: next });
    onSideBySideToggled?.();
  };

  const navigateToChange = (finder: (lines: number[], current: number) => number) => {
    const editor = editorRef.current;
    if (!editor) return;
    const changes = editor.getLineChanges();
    if (!changes || changes.length === 0) return;
    const changeLines = changes.map((c) => c.modifiedStartLineNumber);
    const currentLine = editor.getModifiedEditor().getPosition()?.lineNumber ?? 1;
    const targetLine = finder(changeLines, currentLine);
    editor.getModifiedEditor().setPosition({ lineNumber: targetLine, column: 1 });
    editor.getModifiedEditor().revealLineInCenter(targetLine);
  };

  const handlePrevChange = () => navigateToChange(prevChange);
  const handleNextChange = () => navigateToChange(nextChange);

  if (doc.binary) return <div className="viewer__notice">Binary file — no diff preview.</div>;
  return (
    <div className="viewer">
      <DiffControlsBar
        sideBySide={sideBySide}
        onToggleSideBySide={handleToggleSideBySide}
        onPrevChange={handlePrevChange}
        onNextChange={handleNextChange}
        hasChanges={hasChanges}
      />
      <div className="viewer__monaco" ref={ref} />
    </div>
  );
}
