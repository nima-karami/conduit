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
 * It is also where the escaped-vs-raw file-name mismatch is reconciled — see
 * `webview/ts-worker-names.ts` and spec 2026-08-21 contract 4.
 *
 * Replaces `monaco-editor/.../ts.worker.js` as the `ts.worker` esbuild entry — see
 * esbuild.mjs and docs/specs/archive/2026-08-07-editor-navigation-parity.md §3e.
 */

import { initialize } from 'monaco-editor/esm/vs/common/initialize.js';
import type {
  TsDefinitionInfo,
  TsExtraLib,
  TsReferenceEntry,
} from 'monaco-editor/esm/vs/language/typescript/tsWorker.js';
import { TypeScriptWorker } from 'monaco-editor/esm/vs/language/typescript/tsWorker.js';
import { buildFileNameAliases } from './ts-worker-names';

/**
 * ScriptKind numbers of the TypeScript build bundled inside monaco's worker. Written out
 * rather than imported: `typescriptServices.js` is not on this module's import path, and the
 * values are passed straight back to it as plain numbers.
 */
const SCRIPT_KIND_TS = 3;
const SCRIPT_KIND_TSX = 4;

class ConduitTypeScriptWorker extends TypeScriptWorker {
  private aliases = new Map<string, string>();
  private aliasesFor: Record<string, TsExtraLib> | null = null;

  /** Rebuilt when monaco swaps the extraLib map in (`updateExtraLibs` assigns a fresh
   *  object), which is the only way it ever changes. */
  private aliasMap(): Map<string, string> {
    if (this.aliasesFor !== this._extraLibs) {
      this.aliases = buildFileNameAliases(Object.keys(this._extraLibs));
      this.aliasesFor = this._extraLibs;
    }
    return this.aliases;
  }

  /** The extraLib key for a file name TypeScript may have spelled raw. */
  private canonical(fileName: string): string {
    if (fileName in this._extraLibs) return fileName;
    return this.aliasMap().get(fileName) ?? fileName;
  }

  /** Results carry the name TypeScript resolved, i.e. the raw one. `LibFiles.getOrCreateModel`
   *  and `ts-nav`'s `targetModel` both look the target up in `getExtraLibs()` by exact string,
   *  so hand back the key or the navigation lands nowhere. */
  private canonicaliseAll<T extends { fileName: string }>(
    entries: T[] | undefined,
  ): T[] | undefined {
    return entries?.map((entry) => {
      const fileName = this.canonical(entry.fileName);
      return fileName === entry.fileName ? entry : { ...entry, fileName };
    });
  }

  // `readFile`, `fileExists` and `getScriptSnapshot` all route through `_getScriptText`, so
  // aliasing here covers module resolution end to end. Resolving to the KEY (rather than
  // reading the extraLib directly) keeps monaco's model-first ordering intact: a dirty open
  // tab still wins over the indexed copy.
  protected override _getScriptText(fileName: string): string | undefined {
    return super._getScriptText(this.canonical(fileName));
  }

  /**
   * The ScriptKind for a file name, fixing the `.mts`/`.cts` families.
   *
   * monaco's own switch handles only `ts`/`tsx`/`js`/`jsx` and sends everything else to
   * `allowJs ? JS : TS` — and `allowJs` is on by default (src/tsconfig-map.ts), so a
   * `.d.mts` declaration file was being PARSED AS JAVASCRIPT. `export declare const x: number`
   * is not valid JS, so the file contributed nothing and every dual-format (tsup/rollup)
   * package's barrel resolved to an empty leaf. See docs/specs/2026-08-21-goto-definition-flows.md
   * §1 and matrix row 30c.
   */
  override getScriptKind(fileName: string): number {
    if (/\.(m|c)?tsx$/i.test(fileName)) return SCRIPT_KIND_TSX;
    if (/\.(m|c)ts$/i.test(fileName)) return SCRIPT_KIND_TS;
    return super.getScriptKind(fileName);
  }

  override getScriptVersion(fileName: string): string {
    return super.getScriptVersion(this.canonical(fileName));
  }

  override async getDefinitionAtPosition(
    fileName: string,
    position: number,
  ): Promise<TsDefinitionInfo[] | undefined> {
    return this.canonicaliseAll(await super.getDefinitionAtPosition(fileName, position));
  }

  override async getReferencesAtPosition(
    fileName: string,
    position: number,
  ): Promise<TsReferenceEntry[] | undefined> {
    return this.canonicaliseAll(await super.getReferencesAtPosition(fileName, position));
  }

  async getTypeDefinitionAtPosition(
    fileName: string,
    position: number,
  ): Promise<TsDefinitionInfo[] | undefined> {
    return this.canonicaliseAll(
      this._languageService.getTypeDefinitionAtPosition(fileName, position),
    );
  }

  async getImplementationAtPosition(
    fileName: string,
    position: number,
  ): Promise<TsDefinitionInfo[] | undefined> {
    return this.canonicaliseAll(
      this._languageService.getImplementationAtPosition(fileName, position),
    );
  }
}

self.onmessage = () => {
  initialize((ctx, createData) => new ConduitTypeScriptWorker(ctx, createData));
};
