import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from '@milkdown/kit/core';
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

function topLevelNodes(doc: ProseNode): ProseNode[] {
  const nodes: ProseNode[] = [];
  doc.forEach((node) => {
    nodes.push(node);
  });
  return nodes;
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
  agentChanged: ReadonlySet<string>;
  onBody(next: string): void;
  onBodyRefused(reason: string): void;
  handle: Ref<PlanEditorHandle>;
}

function PlanEditorSurface({ body, agentChanged, onBody, onBodyRefused, handle }: SurfaceProps) {
  const nodeViewFactory = useNodeViewFactory();
  const baseRef = useRef<SpliceBase>(baseOf(body, null));
  const ctxRef = useRef<Ctx | null>(null);
  const bodyRef = useRef(body);
  const changedRef = useRef(agentChanged);
  const callbacksRef = useRef({ onBody, onBodyRefused });
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
    doc.forEach((node, pos, index) => {
      const oldIndex = kept[index];
      items.push(
        oldIndex === null
          ? { kind: 'new', source: getMarkdown({ from: pos, to: pos + node.nodeSize })(ctx) }
          : { kind: 'keep', oldIndex },
      );
    });

    const next = spliceBody(base.body, base.blocks, items);
    baseRef.current = { body: next, blocks: splitPlan(next).blocks, nodes };
    if (next !== base.body) callbacksRef.current.onBody(next);
  };

  const { get, loading } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctxRef.current = ctx;
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, bodyRef.current);
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

  useImperativeHandle(handle, () => ({
    editorBlockCount: () => get()?.ctx.get(editorViewCtx).state.doc.childCount ?? 0,
    getBody: () => baseRef.current.body,
    view: () => get()?.ctx.get(editorViewCtx) ?? null,
  }));

  return (
    <div className="plan__editor">
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
          agentChanged={props.agentChanged}
          onBody={props.onBody}
          onBodyRefused={props.onBodyRefused}
          handle={props.ref ?? null}
        />
      </ProsemirrorAdapterProvider>
    </MilkdownProvider>
  );
}
