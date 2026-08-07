/**
 * Conduit's TypeScript language worker: monaco's own worker plus the two navigation
 * features it never exposed.
 *
 * `tsMode.js` registers definition, references, hover, rename and friends — but no type
 * definition and no implementation provider, and `TypeScriptWorker` has no methods behind
 * them either. The APIs exist in the TypeScript build monaco bundles; they simply aren't
 * reachable. Subclassing the worker is the supported extension point (monaco's own
 * `customWorkerPath` does the same thing through `importScripts`; bundling our own entry
 * avoids that hop and keeps the code type-checked).
 *
 * Replaces `monaco-editor/.../ts.worker.js` as the `ts.worker` esbuild entry — see
 * esbuild.mjs and docs/specs/archive/2026-08-07-editor-navigation-parity.md §3e.
 */

import { initialize } from 'monaco-editor/esm/vs/common/initialize.js';
import type { TsDefinitionInfo } from 'monaco-editor/esm/vs/language/typescript/tsWorker.js';
import { TypeScriptWorker } from 'monaco-editor/esm/vs/language/typescript/tsWorker.js';

class ConduitTypeScriptWorker extends TypeScriptWorker {
  async getTypeDefinitionAtPosition(
    fileName: string,
    position: number,
  ): Promise<TsDefinitionInfo[] | undefined> {
    return this._languageService.getTypeDefinitionAtPosition(fileName, position);
  }

  async getImplementationAtPosition(
    fileName: string,
    position: number,
  ): Promise<TsDefinitionInfo[] | undefined> {
    return this._languageService.getImplementationAtPosition(fileName, position);
  }
}

self.onmessage = () => {
  initialize((ctx, createData) => new ConduitTypeScriptWorker(ctx, createData));
};
