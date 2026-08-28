import * as monaco from 'monaco-editor';
import type { JSX as ReactJSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { BlameLine, FileContentDTO, HostToWebview } from '../../src/protocol';
import { canSave, post, subscribe, writeFile } from '../bridge';
import { markerIndexAtLine } from '../change-decorations';
import { registerChangeNav } from '../change-nav-registry';
import { getDirtySnapshot, updateDirty } from '../dirty-store';
import { buildEditorMenuItems, type EditorMenuIconKey, NAVIGATION } from '../editor-menu';
import { fontZoomTarget } from '../font-zoom';
import {
  IconCommand,
  IconCompare,
  IconCopy,
  IconDoc,
  IconGraph,
  IconHistory,
  IconSearch,
  IconSparkle,
} from '../icons';
import { sendMention } from '../mention-bus';
import { monacoKeybindingFor } from '../monaco-keybinding';
import { ensureTokenizer } from '../monaco-languages';
import { ensureTheme } from '../monaco-theme';
import { gotoInflight } from '../monaco-warmup';
import {
  canonicalPath,
  fileUri,
  publishCursor,
  subscribeReveal,
  takeReveal,
} from '../project-index';
import { relativeTime } from '../relative-time';
import { notifySaved, registerSave, type SaveEntry } from '../save-registry';
import { useSettings } from '../settings';
import { effectiveCombo, SHORTCUT_ACTIONS } from '../shortcuts';
import { pushToast } from '../toast-store';
import { runNavCommand, TS_LANGS } from '../ts-nav';
import { refreshIndexedFile } from '../ts-project';
import { type ChangeMarkersApi, DEGRADED_HINT, useChangeMarkers } from '../use-change-markers';
import { makeDebouncedFlush } from '../use-debounced-flush';
import { usePeekZone } from '../use-peek-zone';
import { getViewState, setViewState, VIEW_STATE_DEBOUNCE_MS } from '../view-state-store';
import { ChangePeek } from './change-peek';
import { ContextMenu, type MenuState } from './context-menu';
import { ImageViewer } from './image-viewer';

const MENU_ICONS: Record<EditorMenuIconKey, ReactJSX.Element> = {
  copy: <IconCopy size={14} />,
  search: <IconSearch size={14} />,
  graph: <IconGraph size={14} />,
  command: <IconCommand size={14} />,
  doc: <IconDoc size={14} />,
  mention: <IconSparkle size={14} />,
  history: <IconHistory size={14} />,
  compare: <IconCompare size={14} />,
};

/**
 * VS Code accelerators for the navigation commands, keyed by the built-in command id.
 *
 * Monaco binds these itself, but the built-in keybinding would run the command DIRECTLY —
 * skipping the in-flight indicator, the deadline and the still-indexing message. Re-binding
 * them to our own actions (which delegate to the same command) keeps the keyboard path and
 * the menu path identical, and puts the commands in the command palette.
 */
/** monaco.KeyCode is a reverse-mapped numeric enum, so Object.entries yields both name->number
 *  and number->name; only the first direction is a key table. */
const MONACO_KEY_CODES: Record<string, number> = Object.fromEntries(
  Object.entries(monaco.KeyCode).filter((e): e is [string, number] => typeof e[1] === 'number'),
);

/** The combo currently bound to an app shortcut action, '' when the action is unknown. */
const comboFor = (actionId: string, overrides: Record<string, string>): string => {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
  return action ? effectiveCombo(action, overrides) : '';
};

const NAV_KEYBINDINGS: Record<string, number[]> = {
  'editor.action.revealDefinition': [monaco.KeyCode.F12],
  'editor.action.goToImplementation': [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12],
  'editor.action.goToReferences': [monaco.KeyMod.Shift | monaco.KeyCode.F12],
  'editor.action.peekDefinition': [monaco.KeyMod.Alt | monaco.KeyCode.F12],
  'editor.action.referenceSearch.trigger': [
    monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.F12,
  ],
};

/** Last path segment (for human-readable save messages). */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function CodeViewer({
  doc,
  viewStateId,
  sessionId,
  onReviewCommit,
}: {
  doc: FileContentDTO;
  // Defaults to the `file:` doc id; the markdown "View source" toggle passes a distinct id so
  // its transient Monaco view state can't clobber the rendered-mode scroll under the same path.
  viewStateId?: string;
  /** Owning session — scopes the `git:blame` request to that session's repo. */
  sessionId?: string;
  /** git-blame: open the clicked line's commit in Review (the sha is the full oid). `repoRoot`
   * (the blamed file's OWN repo) and `sessionId` (the doc's owning session) scope the Review to
   * that repo — otherwise a split/multi-repo click looks the commit up in the pinned repo. */
  onReviewCommit?: (sha: string, subject: string, repoRoot?: string, sessionId?: string) => void;
}) {
  const vsId = viewStateId ?? `file:${doc.path}`;
  // Read via refs inside the mount-bound editor effect so a new prop identity (onReviewCommit
  // is a fresh arrow each render) never re-creates the editor.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const onReviewCommitRef = useRef(onReviewCommit);
  onReviewCommitRef.current = onReviewCommit;
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // On-disk baseline (dirty = buffer !== baseline). In a ref so the mount-bound save
  // command and the change handler always see the latest value; advanced on save.
  const baselineRef = useRef(doc.content);
  baselineRef.current = doc.content;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [resolving, setResolving] = useState(false);
  const { settings, update } = useSettings();
  // In a ref so the mount-bound Alt+Z action toggles the current value without re-binding.
  const wordWrapRef = useRef(settings.wordWrap);
  wordWrapRef.current = settings.wordWrap;
  const minimapRef = useRef(settings.editorMinimap);
  minimapRef.current = settings.editorMinimap;
  // The live editor as STATE, not just a ref: the change-marker hook has to re-run when a new
  // instance is created, and a ref mutation doesn't re-render.
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Read by the change actions and the context menu, both of which are built once.
  const changesRef = useRef<ChangeMarkersApi | null>(null);
  // Read at right-click time so a rebind shows on the menu row without re-creating the editor.
  const shortcutsRef = useRef(settings.shortcuts);
  shortcutsRef.current = settings.shortcuts;
  // Read at mount without becoming an effect dep (a dep would recreate the editor on
  // every zoom step). Live changes flow through updateOptions below.
  const editorFontRef = useRef(settings.editorFontSize);
  editorFontRef.current = settings.editorFontSize;

  useEffect(() => {
    if (!ref.current) return;
    const theme = ensureTheme();
    // Register the grammar BEFORE the model and the editor exist: Monaco's own registration
    // is lazy behind a dynamic import, which makes the first paint plain unstyled text.
    ensureTokenizer(doc.language);
    // file:// model URI so the TS/JS language service recognises the file
    // (enables go-to-definition, hover, peek). Reuse an existing model if present.
    const uri = fileUri(doc.path);
    const existing = monaco.editor.getModel(uri);
    const model =
      existing ?? monaco.editor.createModel(doc.binary ? '' : doc.content, doc.language, uri);
    // Re-seed a REUSED model so a clean re-open picks up fresh on-disk content (models
    // persist for cross-file go-to-definition, so a stale buffer would otherwise
    // survive — K3). NEVER re-seed a DIRTY model: it would destroy unsaved edits.
    if (existing && !doc.binary && !getDirtySnapshot().has(doc.path)) {
      if (existing.getValue() !== doc.content) existing.setValue(doc.content);
      // Monaco creates a navigation target's model itself, hardcoding `typescript` as the
      // language (LibFiles.getOrCreateModel). Landing on a .js/.json/.md file that way and
      // then opening it as a tab would leave it tokenized as TypeScript forever.
      if (existing.getLanguageId() !== doc.language)
        monaco.editor.setModelLanguage(existing, doc.language);
    }
    const editor = monaco.editor.create(ref.current, {
      model,
      theme,
      // Binary files render a notice instead, so this never exposes a writable
      // buffer for a non-text file.
      readOnly: false,
      automaticLayout: true,
      minimap: {
        enabled: minimapRef.current,
        // Character rendering makes the map a texture; Lane A needs it to be a MAP, with the
        // change marks legible on it (spec 2026-08-27-review-supercharge §2 Lane A).
        renderCharacters: false,
        showSlider: 'mouseover',
      },
      // Suppress Monaco's own off-theme menu; onContextMenu below opens the app's shared one.
      contextmenu: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: editorFontRef.current,
      scrollBeyondLastLine: false,
      // Frame 8b breathes between the breadcrumb's hairline and the first line.
      padding: { top: 8 },
      wordWrap: wordWrapRef.current ? 'on' : 'off',
      // Frame 8b washes the whole current-line row. Still no box outline around it —
      // editor.lineHighlightBorder is transparent (monaco-theme.ts).
      renderLineHighlight: 'all',
    });
    editorRef.current = editor;

    // Seed the dirty flag once now (the model may be reused with a buffer that already
    // differs from a freshly-loaded baseline), then recompute on every edit.
    const syncDirty = () => updateDirty(doc.path, baselineRef.current, model.getValue());
    syncDirty();
    const changeSub = model.onDidChangeContent(syncDirty);

    let saving = false;
    // Surface a save failure unmissably (banner + toast). A successful save toasts
    // NOTHING — the dot clearing is the only signal. K2: "it silently doesn't save".
    const fail = (reason: string) => {
      setSaveError(reason);
      pushToast({ message: `Could not save ${baseName(doc.path)}: ${reason}`, variant: 'error' });
    };
    // Returns true on success (or already clean), false on failure.
    const save = async (): Promise<boolean> => {
      if (saving) return false;
      const buffer = model.getValue();
      if (buffer === baselineRef.current) return true; // already clean — success
      if (!canSave) {
        fail('Saving is unavailable in the browser preview.');
        return false;
      }
      saving = true;
      setSaveError(null);
      try {
        const res = await writeFile(doc.path, buffer);
        if (res.ok) {
          baselineRef.current = buffer;
          updateDirty(doc.path, buffer, model.getValue());
          // Push saved content to app.tsx's files map so markdown viewers re-render
          // without a host round-trip (K3).
          notifySaved(doc.path, buffer);
          // …and to the language worker, so files that resolve INTO this one (which have no
          // model, only indexed content) navigate against what was just written.
          refreshIndexedFile(doc.path, buffer);
          return true;
        } else {
          fail(res.error);
          return false;
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        saving = false;
      }
    };
    const revert = () => {
      model.setValue(baselineRef.current); // syncDirty fires via onDidChangeContent
    };
    // Register so the GLOBAL Mod+S handler (app.tsx) and the dirty-tab affordance can
    // save even when focus is outside the editor (K2). Monaco's own binding below also
    // calls this same self-guarded `save`, so a double-fire is a harmless no-op.
    const entry: SaveEntry = { save, revert };
    const unregisterSave = registerSave(doc.path, entry);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save();
    });
    // Also an action so Save shows in the command palette.
    editor.addAction({
      id: 'agentdeck.saveFile',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void save();
      },
    });

    // If we arrived via cross-file go-to-definition, reveal the target. An explicit reveal WINS
    // over saved-scroll restore (spec 2026-06-30 §3); only restore the saved view state otherwise.
    const pos = takeReveal(doc.path);
    if (pos) {
      editor.setPosition({ lineNumber: pos.line, column: pos.column });
      editor.revealLineInCenter(pos.line);
    } else {
      const saved = getViewState(vsId);
      if (saved?.kind === 'monaco' && saved.state) editor.restoreViewState(saved.state);
    }

    // Capture scroll+cursor+selection+folding via one saveViewState; debounced live + a sync
    // final capture on teardown (the safety net).
    const captureViewState = () => {
      const ed = editorRef.current;
      if (ed) setViewState(vsId, { kind: 'monaco', state: ed.saveViewState() });
    };
    const debouncedCapture = makeDebouncedFlush(captureViewState, VIEW_STATE_DEBOUNCE_MS);
    const scrollSub = editor.onDidScrollChange(() => debouncedCapture.schedule());

    // Every navigation entry point — this action list, F12, and the context menu — goes
    // through `runNavCommand`, which owns the outcome AND its message (including the non-TS
    // notice this used to raise itself). See
    // docs/specs/2026-08-21-goto-definition-flows.md contract 3.
    const navigate = (actionId: string) => {
      void runNavCommand(editor, actionId);
    };
    for (const n of NAVIGATION) {
      editor.addAction({
        id: `conduit.${n.id}`,
        label: n.label,
        keybindings: NAV_KEYBINDINGS[n.actionId] ?? [],
        run: () => navigate(n.actionId),
      });
    }
    // Toggles the persisted setting; the live-apply effect below propagates the new
    // value to every open editor via updateOptions.
    editor.addAction({
      id: 'agentdeck.toggleWordWrap',
      label: 'Toggle Word Wrap',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
      run: () => update({ wordWrap: !wordWrapRef.current }),
    });
    // Right-click opens the app's shared context menu (Monaco's native one is
    // suppressed via `contextmenu: false`). The menu's "Go to Definition" routes to
    // our custom `agentdeck.goToDefinition` — the built-in TS one can't navigate
    // cross-file from a standalone editor.
    const ctxSub = editor.onContextMenu((e) => {
      e.event.preventDefault();
      const mdl = editor.getModel();
      const sel = editor.getSelection();
      const hasSelection = !!sel && !sel.isEmpty();
      const canGoToDefinition = !!mdl && TS_LANGS.has(mdl.getLanguageId());
      const specs = buildEditorMenuItems({
        readOnly: false,
        hasSelection,
        canGoToDefinition,
        hasChanges: (changesRef.current?.markers.length ?? 0) > 0,
        changeCombos: {
          next: comboFor('nextChange', shortcutsRef.current),
          prev: comboFor('prevChange', shortcutsRef.current),
        },
      });
      // Viewport coords for the fixed-position menu; posx/posy are page-based and would drift.
      setMenu({
        x: e.event.browserEvent.clientX,
        y: e.event.browserEvent.clientY,
        items: specs.map((s) => ({
          label: s.label,
          icon: s.iconKey ? MENU_ICONS[s.iconKey] : undefined,
          disabled: s.disabled,
          separatorBefore: s.separatorBefore,
          hint: s.hint,
          onClick: () => {
            editor.focus();
            if (s.action.kind === 'nav') {
              navigate(s.action.actionId);
            } else if (s.action.kind === 'copy') {
              // Read at click-time (not the build-time closure) so Copy reflects the live selection.
              const range = editor.getSelection();
              const text = range ? (editor.getModel()?.getValueInRange(range) ?? '') : '';
              void navigator.clipboard?.writeText(text);
            } else if (s.action.kind === 'mention') {
              const range = editor.getSelection();
              if (range) {
                sendMention({
                  path: doc.path,
                  startLine: range.startLineNumber,
                  endLine: range.endLineNumber,
                });
              }
            } else {
              void editor.getAction(s.action.actionId)?.run();
            }
          },
        })),
      });
    });
    // Ctrl/Cmd+Click also navigates to definition. A Ctrl+click that lands off a symbol gets
    // the same inline, auto-dismissing note as any other miss — but on a NON-TS file it stays
    // silent, because Ctrl+click is not a deliberate request the way a menu row is, and a
    // toast for every stray modifier-click would be.
    const mouseSub = editor.onMouseDown((e) => {
      if ((e.event.ctrlKey || e.event.metaKey) && e.target.position) {
        const mdl = editor.getModel();
        if (!mdl || !TS_LANGS.has(mdl.getLanguageId())) return;
        editor.setPosition(e.target.position);
        void runNavCommand(editor, 'editor.action.revealDefinition');
      }
    });

    // Drive the breadcrumb bar's cursor position (E3).
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      const mdl = editor.getModel();
      if (!mdl) return;
      publishCursor({ path: doc.path, offset: mdl.getOffsetAt(e.position) });
    });
    // Seed it once so the breadcrumb populates immediately.
    const initPos = editor.getPosition();
    if (initPos && model) publishCursor({ path: doc.path, offset: model.getOffsetAt(initPos) });

    // --- Git blame lens (git-blame) --------------------------------------------------------
    // Low-noise v1: a single trailing lens on the ACTIVE line only (GitLens-style), rendered as
    // a clickable content widget so a committed line links to its Review; an uncommitted line is
    // labelled and inert. Blame is fetched on toggle-on and kept in a per-line map.
    let blameOn = false;
    let blameByLine = new Map<number, BlameLine>();
    let blameRoot: string | undefined; // the blamed file's own repo, from git:blameResult
    const lensNode = document.createElement('div');
    lensNode.className = 'blame-lens';
    let lensTarget: BlameLine | null = null; // the commit the lens currently links to (or null)
    lensNode.addEventListener('click', () => {
      if (lensTarget && !lensTarget.uncommitted)
        onReviewCommitRef.current?.(
          lensTarget.sha,
          lensTarget.summary,
          blameRoot,
          sessionIdRef.current,
        );
    });
    let lensPosition: monaco.IPosition | null = null;
    const lensWidget: monaco.editor.IContentWidget = {
      getId: () => 'agentdeck.blameLens',
      getDomNode: () => lensNode,
      getPosition: () =>
        lensPosition
          ? {
              position: lensPosition,
              preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
            }
          : null,
    };
    editor.addContentWidget(lensWidget);

    const renderLens = () => {
      const mdl = editor.getModel();
      const p = editor.getPosition();
      const bl = blameOn && mdl && p ? blameByLine.get(p.lineNumber) : undefined;
      if (!bl || !mdl || !p) {
        lensTarget = null;
        lensPosition = null;
        lensNode.textContent = '';
        editor.layoutContentWidget(lensWidget);
        return;
      }
      if (bl.uncommitted) {
        lensTarget = null;
        lensNode.textContent = bl.author;
        lensNode.dataset.clickable = 'false';
      } else {
        lensTarget = bl;
        lensNode.textContent = `${bl.author}, ${relativeTime(bl.authorTime * 1000)} · ${bl.summary}`;
        lensNode.dataset.clickable = 'true';
      }
      lensPosition = { lineNumber: p.lineNumber, column: mdl.getLineMaxColumn(p.lineNumber) };
      editor.layoutContentWidget(lensWidget);
    };

    const blameCursorSub = editor.onDidChangeCursorPosition(() => renderLens());
    const blameUnsub = subscribe((msg: HostToWebview) => {
      if (
        msg.type === 'git:blameResult' &&
        msg.sessionId === sessionIdRef.current &&
        msg.path === doc.path
      ) {
        blameByLine = new Map(msg.lines.map((l) => [l.line, l]));
        blameRoot = msg.root;
        if (msg.error) pushToast({ message: msg.error, variant: 'error' });
        renderLens();
      }
    });
    editor.addAction({
      id: 'agentdeck.toggleGitBlame',
      label: 'Toggle Git Blame',
      run: () => {
        blameOn = !blameOn;
        if (blameOn) {
          const sid = sessionIdRef.current;
          if (sid) post({ type: 'git:blame', sessionId: sid, path: doc.path });
        } else {
          blameByLine = new Map();
          blameRoot = undefined;
        }
        renderLens();
      },
    });

    setEditor(editor);

    // Don't dispose models we keep for cross-file resolution; only dispose the editor.
    return () => {
      debouncedCapture.cancel();
      captureViewState(); // sync final capture BEFORE dispose, else saveViewState has no editor
      unregisterSave();
      changeSub.dispose();
      scrollSub.dispose();
      mouseSub.dispose();
      ctxSub.dispose();
      cursorSub.dispose();
      blameCursorSub.dispose();
      blameUnsub();
      editor.dispose();
      editorRef.current = null;
      setEditor(null);
    };
  }, [doc.path, doc.content, doc.language, doc.binary, update, vsId]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: settings.wordWrap ? 'on' : 'off' });
  }, [settings.wordWrap]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: settings.editorFontSize });
  }, [settings.editorFontSize]);

  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: settings.editorMinimap } });
  }, [settings.editorMinimap]);

  // Monaco resolves a keybinding at addAction time, so a rebind in Settings only reaches the
  // editor if the actions are disposed and re-registered — otherwise the old combo survives
  // until the tab is reopened. A combo monaco cannot express binds nothing here; app.tsx's
  // dispatcher still routes the action through the change-nav registry.
  useEffect(() => {
    if (!editor) return;
    const tables = {
      CtrlCmd: monaco.KeyMod.CtrlCmd,
      Shift: monaco.KeyMod.Shift,
      Alt: monaco.KeyMod.Alt,
      WinCtrl: monaco.KeyMod.WinCtrl,
      keyCodes: MONACO_KEY_CODES,
    };
    const keysFor = (actionId: string): number[] => {
      const binding = monacoKeybindingFor(comboFor(actionId, settings.shortcuts), tables);
      return binding === null ? [] : [binding];
    };
    const actions = [
      editor.addAction({
        id: 'agentdeck.nextChange',
        label: 'Go to Next Change',
        keybindings: keysFor('nextChange'),
        run: () => changesRef.current?.goToChange('next'),
      }),
      editor.addAction({
        id: 'agentdeck.prevChange',
        label: 'Go to Previous Change',
        keybindings: keysFor('prevChange'),
        run: () => changesRef.current?.goToChange('prev'),
      }),
      editor.addAction({
        // No keybinding: the editor is editable, so the peek is reached through the context
        // menu and the command palette rather than a key that would fight typing (§9).
        id: 'agentdeck.peekChange',
        label: 'Peek Change',
        run: (ed) => {
          const markers = markersRef.current;
          if (markers.length === 0) return;
          const line = ed.getPosition()?.lineNumber ?? 1;
          const at = markerIndexAtLine(markers, line);
          // Off a marker, take the next one down the file so the row is never inert.
          const i =
            at >= 0
              ? at
              : Math.max(
                  markers.findIndex((m) => m.startLine >= line),
                  0,
                );
          peekRef.current?.open(i);
        },
      }),
    ];
    return () => {
      for (const a of actions) a.dispose();
    };
  }, [editor, settings.shortcuts]);

  // Live reveal for an ALREADY-open doc: the onMount reveal won't re-run, so consume
  // the staged target here and center it. New-tab opens go through the onMount path.
  useEffect(() => {
    return subscribeReveal((path) => {
      const ed = editorRef.current;
      if (!ed) return;
      if (path !== canonicalPath(doc.path)) return;
      const pos = takeReveal(doc.path);
      if (!pos) return;
      ed.setPosition({ lineNumber: pos.line, column: pos.column });
      ed.revealLineInCenter(pos.line);
      ed.focus();
    });
  }, [doc.path]);

  // Drive the loading indicator so a slow (cold-worker) go-to-definition shows
  // progress instead of a frozen editor (E1).
  useEffect(() => {
    const sync = () => setResolving(gotoInflight.active());
    sync();
    return gotoInflight.subscribe(sync);
  }, []);

  // Re-theme on theme or code-block colour/opacity change (wishlist C3). Surface values are
  // passed straight in so they can't lag a render behind the provider's applyToDom effect,
  // but the syntax palette is read from the CSS vars — hence the rAF, which lets applyToDom
  // (a parent effect, so it runs after this one) put the new data-theme on <html> first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: settings.theme is the re-theme trigger — the palette is read off <html>'s CSS vars, not from the value.
  useEffect(() => {
    if (!editorRef.current) return;
    const id = requestAnimationFrame(() => {
      monaco.editor.setTheme(
        ensureTheme({ surfaceColor: settings.surfaceColor, codeOpacity: settings.codeOpacity }),
      );
    });
    return () => cancelAnimationFrame(id);
  }, [settings.theme, settings.surfaceColor, settings.codeOpacity]);

  const changes = useChangeMarkers({
    editor,
    path: doc.path,
    // A truncated buffer holds only the first 2 MB, so every line past the cut would read as a
    // deletion against the full HEAD blob.
    enabled: settings.editorChangeMarkers && !doc.binary && !doc.truncated,
    themeId: settings.theme,
  });
  changesRef.current = changes;

  // Announcements the peek makes ("Staged hunk"), kept apart from the marker hook's own live
  // region so a navigation announcement and an op announcement cannot overwrite each other.
  const [hunkAnnounce, setHunkAnnounce] = useState('');

  const peek = usePeekZone({
    editor,
    markers: changes.markers,
    render: (index, total, close) => (
      <ChangePeek
        marker={changes.markers[index]}
        index={index}
        total={total}
        path={doc.path}
        untracked={changes.untracked}
        hashes={changes.hashes}
        onClose={close}
        onNext={() => peekRef.current?.next()}
        onPrev={() => peekRef.current?.prev()}
        onAnnounce={setHunkAnnounce}
      />
    ),
  });
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const markersRef = useRef(changes.markers);
  markersRef.current = changes.markers;

  // Clicking a gutter marker opens the peek. Its own effect rather than a branch inside the
  // mount effect: `editor` is state, so this re-binds with a new instance without dragging the
  // 300-line mount effect along, and the two refs keep it from re-binding on every recompute.
  useEffect(() => {
    if (!editor) return;
    const sub = editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const line = e.target.position?.lineNumber;
      if (line === undefined) return;
      const i = markerIndexAtLine(markersRef.current, line);
      if (i >= 0) peekRef.current?.open(i);
    });
    return () => sub.dispose();
  }, [editor]);

  useEffect(() => {
    return registerChangeNav(doc.path, {
      next: () => changes.goToChange('next'),
      prev: () => changes.goToChange('prev'),
      hasChanges: () => changes.markers.length > 0,
    });
  }, [doc.path, changes]);

  // Image files (including SVG) bypass Monaco — ImageViewer handles them.
  if (doc.image || (doc.binary && doc.error?.includes('too large')))
    return <ImageViewer doc={doc} />;
  if (doc.binary) return <div className="viewer__notice">Binary file — no preview.</div>;
  return (
    <div
      className="viewer"
      data-resolving={resolving || undefined}
      // Capture phase intercepts Ctrl/Cmd +/-/0 zoom before Monaco's keybinding service.
      onKeyDownCapture={(e) => {
        const zoom = fontZoomTarget(settings.editorFontSize, e);
        if (zoom !== null) {
          e.preventDefault();
          e.stopPropagation();
          update({ editorFontSize: zoom });
        }
      }}
    >
      {doc.truncated && <div className="viewer__banner">Large file — showing the first 2 MB.</div>}
      {changes.state === 'degraded' && <div className="viewer__banner">{DEGRADED_HINT}</div>}
      {saveError && (
        <div className="viewer__banner viewer__banner--error" role="alert">
          Could not save: {saveError}
        </div>
      )}
      <div className="viewer__monaco" ref={ref} />
      {peek.portal}
      {resolving && (
        <div className="viewer__loading" role="status" aria-live="polite">
          {/* Not "Resolving definition…": the same indicator now covers references,
              implementations and type definitions. */}
          Resolving…
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      <div className="sr-only viewer__announce" role="status" aria-live="polite">
        {changes.announcement}
      </div>
      <div className="sr-only viewer__announce" role="status" aria-live="polite">
        {hunkAnnounce}
      </div>
    </div>
  );
}
