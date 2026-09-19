/**
 * Diagnostics for ONE model, asked for directly rather than switched on globally.
 *
 * `webview/monaco-setup.ts` keeps `noSemanticValidation` / `noSyntaxValidation` on for the
 * whole app — red squiggles in the file viewer are not wanted — so the code fences in a plan
 * get theirs by querying the worker per model and publishing the result under our own marker
 * owner. See docs/plans/2026-09-19-interactive-plan.plan.md, Task 5.1.
 */

import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import { fileUri } from './project-index';

const OWNER = 'plan-ts';
const DEBOUNCE_MS = 300;

/** Under the project root so the block resolves against the same extraLibs as the project. */
export function blockModelUri(
  root: string,
  slug: string,
  nonce: string,
  lang: 'ts' | 'tsx',
): monaco.Uri {
  return fileUri(`${root}/.conduit/plans/.blocks/${slug}.${nonce}.${lang}`);
}

export interface WorkerDiagnostic {
  start?: number;
  length?: number;
  messageText: string | { messageText: string };
  category: number;
  code: number;
}

function severityOf(category: number): monaco.MarkerSeverity {
  if (category === 1) return monaco.MarkerSeverity.Error;
  if (category === 0) return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

export function toMarkers(
  model: monaco.editor.ITextModel,
  diags: readonly WorkerDiagnostic[],
): monaco.editor.IMarkerData[] {
  return diags.map((d) => {
    const start = d.start ?? 0;
    const from = model.getPositionAt(start);
    const to = model.getPositionAt(start + (d.length ?? 0));
    return {
      severity: severityOf(d.category),
      message: typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText,
      code: String(d.code),
      startLineNumber: from.lineNumber,
      startColumn: from.column,
      endLineNumber: to.lineNumber,
      endColumn: to.column,
    };
  });
}

/** Publishes syntactic + semantic markers for `model` until the returned disposer runs. */
export function attachBlockDiagnostics(model: monaco.editor.ITextModel): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const refresh = async () => {
    // Every await is a chance for the disposer (or a model dispose) to have run.
    const getWorker = await monacoTs.getTypeScriptWorker();
    if (stopped || model.isDisposed()) return;
    const worker = await getWorker(model.uri);
    if (stopped || model.isDisposed()) return;
    const fileName = model.uri.toString();
    const [syntactic, semantic] = await Promise.all([
      worker.getSyntacticDiagnostics(fileName),
      worker.getSemanticDiagnostics(fileName),
    ]);
    if (stopped || model.isDisposed()) return;
    monaco.editor.setModelMarkers(model, OWNER, toMarkers(model, [...syntactic, ...semantic]));
  };

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, DEBOUNCE_MS);
  };

  const sub = model.onDidChangeContent(schedule);
  void refresh();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    sub.dispose();
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, OWNER, []);
  };
}
