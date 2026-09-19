import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { codeBlockSchema, commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose, $view, getMarkdown, replaceAll } from '@milkdown/kit/utils';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import {
  ProsemirrorAdapterProvider,
  useNodeViewContext,
  useNodeViewFactory,
} from '@prosemirror-adapter/react';
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { type PlanBlock, splitPlan } from '../../src/plan-blocks';
import { keepMap, type SpliceItem, spliceBody } from '../../src/plan-splice';
import { PlanCodeBlock } from './plan-code-block';
import { PlanFlowBlock } from './plan-flow-block';

export interface PlanEditorProps {
  body: string;
  readOnly: boolean;
  onBody(next: string): void;
  onBodyRefused(reason: string): void;
  onBlockFocus(index: number | null): void;
  agentChanged: ReadonlySet<string>;
  ref?: Ref<PlanEditorHandle>;
}

export interface PlanEditorHandle {
  editorBlockCount(): number;
  getBody(): string;
  /**
   * Re-base on the live document and emit it, for Retry. The base only advances on a successful
   * emit, so after a refusal `getBody()` is the last CONSISTENT body — saving that would write
   * over what the user typed and report success. Returns whether a body reached `onBody`.
   */
  resync(): boolean;
  /** The rendered element of a top-level block, for chrome the view paints beside it. */
  blockDom(index: number): HTMLElement | null;
  /** Test seam: the splice tests drive real ProseMirror transactions. */
  view(): EditorView | null;
}

/**
 * The editor-local splice base (plan docs/plans/2026-09-19-interactive-plan.plan.md, Task 4.4).
 * `nodes` are the top-level ProseMirror children `body` was last built from, so node identity —
 * never a text comparison — decides which blocks keep their bytes.
 */
interface SpliceBase {
  body: string;
  blocks: PlanBlock[];
  nodes: ProseNode[];
}

const changedKey = new PluginKey<ReadonlySet<string>>('MILKDOWN_PLAN_AGENT_CHANGED');
const NO_HASHES: ReadonlySet<string> = new Set();

/**
 * The top-level block an event landed in, by walking the DOM rather than asking ProseMirror:
 * every fence is a node view with `stopEvent: () => true`, and PM drops such an event before any
 * `handleDOMEvents` prop sees it — so a plugin would be blind to exactly the blocks the gutter
 * most needs (the diagram and the signature).
 */
function topLevelIndex(content: Element, target: EventTarget | null): number | null {
  if (!(target instanceof Node)) return null;
  let node: Node | null = target;
  while (node !== null && node.parentNode !== content) node = node.parentNode;
  if (node === null) return null;
  const index = Array.prototype.indexOf.call(content.children, node);
  return index < 0 ? null : index;
}

/**
 * The document's top-level blocks. ProseMirror has no empty document — it always holds one empty
 * paragraph — where markdown with no blocks has none, and the two are the same document: counting
 * that paragraph would leave the base permanently one block ahead of `splitPlan`, so every edit to
 * an empty or frontmatter-only plan would be refused as the two parsers disagreeing.
 *
 * A PARAGRAPH, exactly: markdown cannot represent an empty one, so the test is exact. Any other
 * empty textblock — an opened-but-unfilled fence, a bare `#` — is a block remark counts, and
 * discounting it would park the plan at nodes 0 / blocks 1 with every keystroke refused and Retry
 * unable to clear it, because the reload reproduces the same document.
 */
function topLevelNodes(doc: ProseNode): ProseNode[] {
  const nodes: ProseNode[] = [];
  doc.forEach((node) => {
    nodes.push(node);
  });
  const only = nodes.length === 1 ? nodes[0] : undefined;
  return only?.type.name === 'paragraph' && only.content.size === 0 ? [] : nodes;
}

function baseOf(body: string, doc: ProseNode | null): SpliceBase {
  return { body, blocks: splitPlan(body).blocks, nodes: doc === null ? [] : topLevelNodes(doc) };
}

/**
 * Marks the blocks the agent last wrote. A node carries no hash, so it is read off the splice base
 * by index — which holds because the base is re-based on every emitted transaction and on every
 * external reload.
 */
function agentChangedPlugin(blocksOf: () => readonly PlanBlock[]): Plugin<ReadonlySet<string>> {
  return new Plugin<ReadonlySet<string>>({
    key: changedKey,
    state: {
      init: () => NO_HASHES,
      apply: (tr, value) => (tr.getMeta(changedKey) as ReadonlySet<string> | undefined) ?? value,
    },
    props: {
      decorations(state) {
        const changed = changedKey.getState(state);
        if (changed === undefined || changed.size === 0) return DecorationSet.empty;
        const blocks = blocksOf();
        const decorations: Decoration[] = [];
        state.doc.forEach((node, pos, index) => {
          const hash = blocks[index]?.hash;
          if (hash !== undefined && changed.has(hash)) {
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-changed': 'true' }));
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

function CodeBlockSwitch() {
  const { node } = useNodeViewContext();
  return node.attrs.language === 'mermaid' ? <PlanFlowBlock /> : <PlanCodeBlock />;
}

/**
 * ProseMirror only stamps `contenteditable=false` on a node view that declares no contentDOM, and
 * the adapter makes one for every non-leaf node — `code_block` has inline content, so it always
 * gets one. Left editable, a click on the Monaco block lands the caret in the PROSE instead and
 * the fence never sees a keystroke; `stopEvent` does not help, because it is the browser placing
 * that caret, not an event ProseMirror handled.
 */
function blockRoot(): HTMLDivElement {
  const dom = document.createElement('div');
  dom.contentEditable = 'false';
  return dom;
}

interface SurfaceProps {
  body: string;
  readOnly: boolean;
  agentChanged: ReadonlySet<string>;
  onBody(next: string): void;
  onBodyRefused(reason: string): void;
  onBlockFocus(index: number | null): void;
  handle: Ref<PlanEditorHandle>;
}

function PlanEditorSurface({
  body,
  readOnly,
  agentChanged,
  onBody,
  onBodyRefused,
  onBlockFocus,
  handle,
}: SurfaceProps) {
  const nodeViewFactory = useNodeViewFactory();
  const hostRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef(onBlockFocus);
  focusRef.current = onBlockFocus;
  const baseRef = useRef<SpliceBase>(baseOf(body, null));
  const ctxRef = useRef<Ctx | null>(null);
  const bodyRef = useRef(body);
  const changedRef = useRef(agentChanged);
  const callbacksRef = useRef({ onBody, onBodyRefused });
  const readOnlyRef = useRef(readOnly);
  /** An external body that arrived while the caret was in the document; applied on blur. */
  const deferredRef = useRef<string | null>(null);

  useEffect(() => {
    bodyRef.current = body;
    changedRef.current = agentChanged;
    callbacksRef.current = { onBody, onBodyRefused };
  });

  const applyChanged = useCallback((ctx: Ctx, changed: ReadonlySet<string>): void => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setMeta(changedKey, changed).setMeta('addToHistory', false));
  }, []);

  const reload = useCallback(
    (ctx: Ctx, next: string, changed: ReadonlySet<string>): void => {
      replaceAll(next, true)(ctx);
      baseRef.current = baseOf(next, ctx.get(editorViewCtx).state.doc);
      applyChanged(ctx, changed);
    },
    [applyChanged],
  );

  const emit = (ctx: Ctx, doc: ProseNode): void => {
    const base = baseRef.current;
    if (base.nodes.length !== base.blocks.length) {
      callbacksRef.current.onBodyRefused(
        `block count mismatch at ${Math.min(base.nodes.length, base.blocks.length)}`,
      );
      return;
    }

    const nodes = topLevelNodes(doc);
    const kept = keepMap(base.nodes, nodes);
    const items: SpliceItem[] = [];
    let pos = 0;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const oldIndex = kept[index];
      items.push(
        oldIndex === null
          ? { kind: 'new', source: getMarkdown({ from: pos, to: pos + node.nodeSize })(ctx) }
          : { kind: 'keep', oldIndex },
      );
      pos += node.nodeSize;
    }

    const next = spliceBody(base.body, base.blocks, items);
    baseRef.current = { body: next, blocks: splitPlan(next).blocks, nodes };
    if (next !== base.body) callbacksRef.current.onBody(next);
  };

  const resync = (): boolean => {
    const ctx = ctxRef.current;
    if (ctx === null) return false;
    const base = baseRef.current;
    // The emit succeeded and only the HOST WRITE failed: the base already is the document, and its
    // body is the byte-preserved one that failed to reach disk. Serialising the document here would
    // hand remark-stringify every untouched block — `- ` becomes `* `, `_em_` becomes `*em*` — and
    // one Retry would silently reformat a plan end to end, agent-changed hashes and all.
    if (base.nodes.length === base.blocks.length) {
      callbacksRef.current.onBody(base.body);
      return true;
    }
    // The stale base: the document disagrees with the markdown it serialises to, which is the state
    // that refused in the first place. Re-parsing the serialised body is what restores the parity
    // the splice needs, and it is the only path with nothing byte-preserved left to protect.
    const body = getMarkdown()(ctx);
    reload(ctx, body, changedRef.current);
    if (baseRef.current.nodes.length !== baseRef.current.blocks.length) return false;
    callbacksRef.current.onBody(body);
    return true;
  };

  const { get, loading } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctxRef.current = ctx;
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, bodyRef.current);
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            editable: () => !readOnlyRef.current,
          }));
          ctx
            .get(listenerCtx)
            .mounted((c) => {
              baseRef.current = baseOf(bodyRef.current, c.get(editorViewCtx).state.doc);
            })
            .updated((c, doc) => {
              emit(c, doc);
            })
            .blur((c) => {
              const deferred = deferredRef.current;
              deferredRef.current = null;
              if (deferred !== null && deferred !== baseRef.current.body) {
                reload(c, deferred, changedRef.current);
              }
            });
        })
        .use(commonmark)
        .use(gfm)
        .use(listener)
        .use(history)
        .use($prose(() => agentChangedPlugin(() => baseRef.current.blocks)))
        .use(
          $view(codeBlockSchema.node, () =>
            nodeViewFactory({
              component: CodeBlockSwitch,
              as: blockRoot,
              stopEvent: () => true,
              ignoreMutation: () => true,
            }),
          ),
        ),
    [],
  );

  // ProseMirror reads `editable` once per props update and caches it, so flipping the ref alone
  // leaves the document editable: the new value has to be pushed at the view.
  useEffect(() => {
    readOnlyRef.current = readOnly;
    const ctx = ctxRef.current;
    if (loading || ctx === null) return;
    ctx.get(editorViewCtx).setProps({ editable: () => !readOnly });
    if (!readOnly) return;
    // Read-only is only ever learned from a REFUSED write, so the keystroke that discovered it was
    // accepted into the view and can never reach disk. Deferring the reload to the blur — which is
    // there to stop an agent's write eating the character being typed — would leave the document
    // showing text the file does not have for as long as the caret stays put.
    const pending = deferredRef.current ?? bodyRef.current;
    deferredRef.current = null;
    if (pending !== baseRef.current.body) reload(ctx, pending, changedRef.current);
  }, [readOnly, loading, reload]);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (loading || ctx === null) return;
    if (body !== baseRef.current.body) {
      // Swapping the document under a live caret eats the keystroke being typed. The store only
      // hands over a new body while the session is clean, so deferring to the blur loses nothing.
      if (ctx.get(editorViewCtx).hasFocus()) {
        deferredRef.current = body;
      } else {
        deferredRef.current = null;
        reload(ctx, body, agentChanged);
        return;
      }
    }
    applyChanged(ctx, agentChanged);
  }, [body, agentChanged, loading, reload, applyChanged]);

  const contentDom = useCallback(
    (): Element | null => ctxRef.current?.get(editorViewCtx).dom ?? null,
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (loading || host === null) return;
    let last: number | null = null;
    const report = (index: number | null): void => {
      if (index === last) return;
      last = index;
      focusRef.current(index);
    };
    const track = (e: Event): void => {
      const content = contentDom();
      report(content === null ? null : topLevelIndex(content, e.target));
    };
    const clear = (): void => {
      report(null);
    };
    host.addEventListener('mouseover', track);
    host.addEventListener('mouseleave', clear);
    host.addEventListener('focusin', track);
    return () => {
      host.removeEventListener('mouseover', track);
      host.removeEventListener('mouseleave', clear);
      host.removeEventListener('focusin', track);
    };
  }, [loading, contentDom]);

  useImperativeHandle(handle, () => ({
    editorBlockCount: () => {
      const doc = get()?.ctx.get(editorViewCtx).state.doc;
      return doc === undefined ? 0 : topLevelNodes(doc).length;
    },
    getBody: () => baseRef.current.body,
    resync,
    blockDom: (index) => {
      const child = contentDom()?.children[index];
      return child instanceof HTMLElement ? child : null;
    },
    view: () => get()?.ctx.get(editorViewCtx) ?? null,
  }));

  return (
    <div className="plan__editor" ref={hostRef}>
      <Milkdown />
    </div>
  );
}

export function PlanEditor(props: PlanEditorProps) {
  return (
    <MilkdownProvider>
      <ProsemirrorAdapterProvider>
        <PlanEditorSurface
          body={props.body}
          readOnly={props.readOnly}
          agentChanged={props.agentChanged}
          onBody={props.onBody}
          onBodyRefused={props.onBodyRefused}
          onBlockFocus={props.onBlockFocus}
          handle={props.ref ?? null}
        />
      </ProsemirrorAdapterProvider>
    </MilkdownProvider>
  );
}
