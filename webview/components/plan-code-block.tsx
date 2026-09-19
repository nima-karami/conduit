import { useNodeViewContext } from '@prosemirror-adapter/react';
import * as monaco from 'monaco-editor';
import { createContext, useContext, useEffect, useId, useRef } from 'react';
import { langFromPath } from '../../src/lang';
import { OVERVIEW_RULER_WIDTH } from '../change-decorations';
import { ensureTokenizer } from '../monaco-languages';
import { monacoOverflowHost } from '../monaco-overflow-host';
import { ensureTheme } from '../monaco-theme';
import { attachBlockDiagnostics, blockModelUri } from '../plan-diagnostics';
import { useSettings } from '../settings';

/** The plan a fence belongs to (the model URI needs root and slug) and whether it may be edited.
 *  Provided by PlanView, above the editor, so the node views read it through the adapter's portal. */
export const PlanDocContext = createContext<{ root: string; slug: string; readOnly: boolean }>({
  root: '',
  slug: '',
  readOnly: false,
});

const WRITE_DEBOUNCE_MS = 150;

/** Only these two get a file:// model and diagnostics — see the plan's Contracts block. */
const TS_FENCE: Record<string, 'ts' | 'tsx'> = { ts: 'ts', tsx: 'tsx' };

/** Reuses `src/lang.ts`'s extension table rather than a second copy of it; a fence token that
 *  is already a Monaco language id (`javascript`, `shell`) passes through untranslated. */
function monacoLanguageFor(fence: string): string {
  if (!fence) return 'plaintext';
  const mapped = langFromPath(`block.${fence}`);
  return mapped === 'plaintext' ? fence : mapped;
}

export function PlanCodeBlock() {
  const { node, view, getPos } = useNodeViewContext();
  const { root, slug, readOnly } = useContext(PlanDocContext);
  const { settings } = useSettings();

  const fence = String(node.attrs.language ?? '');
  // React's id carries delimiters (`«r0»`) that would land in the model URI.
  const nonce = useId()
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  // The value we last pushed into the document, so the transaction coming back is not
  // re-applied to the model (which would move the caret to the end mid-typing).
  const selfWriteRef = useRef<string | null>(null);

  // Read inside the mount effect without becoming deps — a new `node` arrives on every
  // document transaction, and re-creating the editor for each one would be unusable.
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const viewRef = useRef(view);
  viewRef.current = view;
  const getPosRef = useRef(getPos);
  getPosRef.current = getPos;
  const minimapRef = useRef(settings.editorMinimap);
  minimapRef.current = settings.editorMinimap;
  const fontSizeRef = useRef(settings.editorFontSize);
  fontSizeRef.current = settings.editorFontSize;
  const wordWrapRef = useRef(settings.wordWrap);
  wordWrapRef.current = settings.wordWrap;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const theme = ensureTheme();
    const tsLang = TS_FENCE[fence] ?? null;
    const language = tsLang ? 'typescript' : monacoLanguageFor(fence);
    // Before the model exists — see monaco-languages.ts on why the order matters.
    ensureTokenizer(language);

    // Only a ts/tsx block joins the TS project (a file:// URI the worker can resolve); every
    // other fence gets an anonymous model, which is tokenization and nothing else.
    const model = tsLang
      ? monaco.editor.createModel(
          nodeRef.current.textContent,
          language,
          blockModelUri(root, slug, nonce, tsLang),
        )
      : monaco.editor.createModel(nodeRef.current.textContent, language);
    modelRef.current = model;

    const editor = monaco.editor.create(host, {
      model,
      theme,
      readOnly: readOnlyRef.current,
      overflowWidgetsDomNode: monacoOverflowHost(),
      fixedOverflowWidgets: true,
      minimap: {
        enabled: minimapRef.current,
        renderCharacters: false,
        showSlider: 'mouseover',
      },
      scrollbar: { verticalScrollbarSize: OVERVIEW_RULER_WIDTH },
      contextmenu: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: fontSizeRef.current,
      scrollBeyondLastLine: false,
      padding: { top: 8 },
      wordWrap: wordWrapRef.current ? 'on' : 'off',
      renderLineHighlight: 'all',
    });
    editorRef.current = editor;

    // `automaticLayout` would measure the container and fight the height set from the content;
    // the block is as tall as what it holds instead.
    const sizeSub = editor.onDidContentSizeChange(() => {
      host.style.height = `${editor.getContentHeight()}px`;
      editor.layout();
    });
    host.style.height = `${editor.getContentHeight()}px`;
    editor.layout();

    // With `automaticLayout` off, a pane resize leaves the editor's width stale. Only a width
    // change is re-laid out: the height is ours to set above, and reacting to it would loop.
    let lastWidth = host.clientWidth;
    const resize = new ResizeObserver(() => {
      if (host.clientWidth === lastWidth) return;
      lastWidth = host.clientWidth;
      editor.layout();
    });
    resize.observe(host);

    let writeTimer: ReturnType<typeof setTimeout> | undefined;
    const write = () => {
      const value = model.getValue();
      const current = nodeRef.current;
      if (value === current.textContent) return;
      const pos = getPosRef.current();
      if (pos === undefined) return;
      const v = viewRef.current;
      const from = pos + 1;
      const to = pos + current.nodeSize - 1;
      selfWriteRef.current = value;
      // An empty fence has no text node to put there — ProseMirror rejects `schema.text('')`.
      v.dispatch(
        value
          ? v.state.tr.replaceWith(from, to, v.state.schema.text(value))
          : v.state.tr.delete(from, to),
      );
    };
    const changeSub = model.onDidChangeContent(() => {
      if (writeTimer !== undefined) clearTimeout(writeTimer);
      writeTimer = setTimeout(() => {
        writeTimer = undefined;
        write();
      }, WRITE_DEBOUNCE_MS);
    });

    const detachDiagnostics = tsLang ? attachBlockDiagnostics(model) : null;

    return () => {
      if (writeTimer !== undefined) clearTimeout(writeTimer);
      detachDiagnostics?.();
      resize.disconnect();
      changeSub.dispose();
      sizeSub.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [fence, nonce, root, slug]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    const text = node.textContent;
    if (text === selfWriteRef.current) {
      selfWriteRef.current = null;
      return;
    }
    if (model.getValue() === text) return;
    model.setValue(text);
  }, [node]);

  // Same shape as code-viewer.tsx: the rAF lets the settings provider stamp the new
  // data-theme on <html> first, since ensureTheme reads the palette off its CSS vars.
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

  return <div className="plan__code" data-lang={fence} ref={hostRef} />;
}
