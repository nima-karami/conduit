import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { history } from '@milkdown/kit/plugin/history';
import { listener } from '@milkdown/kit/plugin/listener';
import { codeBlockSchema, commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { $view } from '@milkdown/kit/utils';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import {
  ProsemirrorAdapterProvider,
  useNodeViewContext,
  useNodeViewFactory,
} from '@prosemirror-adapter/react';
import { type Ref, useImperativeHandle } from 'react';

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
}

function CodeBlockPlaceholder() {
  const { node } = useNodeViewContext();
  return (
    <textarea
      className="plan__codeblock"
      readOnly
      data-lang={String(node.attrs.language ?? '')}
      value={node.textContent}
    />
  );
}

function PlanEditorSurface({ body, handle }: { body: string; handle: Ref<PlanEditorHandle> }) {
  const nodeViewFactory = useNodeViewFactory();

  const { get } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, body);
        })
        .use(commonmark)
        .use(gfm)
        .use(listener)
        .use(history)
        .use(
          $view(codeBlockSchema.node, () =>
            nodeViewFactory({
              component: CodeBlockPlaceholder,
              as: 'div',
              stopEvent: () => true,
              ignoreMutation: () => true,
            }),
          ),
        ),
    [],
  );

  useImperativeHandle(handle, () => ({
    editorBlockCount: () => get()?.ctx.get(editorViewCtx).state.doc.childCount ?? 0,
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
        <PlanEditorSurface body={props.body} handle={props.ref ?? null} />
      </ProsemirrorAdapterProvider>
    </MilkdownProvider>
  );
}
