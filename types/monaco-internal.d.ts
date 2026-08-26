/**
 * Monaco's ESM worker internals, used to extend its TypeScript worker with the two language
 * features it doesn't expose (type definition + implementation — see
 * docs/specs/archive/2026-08-07-editor-navigation-parity.md §3e). The `.js` files ship no
 * declarations, so their shape is declared once here rather than silenced at each import.
 *
 * Only the members Conduit actually calls are declared. The structural span/definition types
 * mirror TypeScript's own; they're spelled out locally so the webview program doesn't have to
 * pull in the whole `typescript` package for two fields.
 */

declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  /** Service identifiers are opaque here — only `get` is used, and only with the decorators
   *  imported from the corresponding platform module. */
  export namespace StandaloneServices {
    function get<T>(id: ServiceIdentifier<T>): T;
  }
  export interface ServiceIdentifier<T> {
    readonly _marker?: T;
  }
}

declare module 'monaco-editor/esm/vs/platform/commands/common/commands.js' {
  import type { ServiceIdentifier } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
  export interface CommandService {
    executeCommand(commandId: string, ...args: unknown[]): Promise<unknown>;
  }
  export const ICommandService: ServiceIdentifier<CommandService>;
}

/** Monaco's URI implementation on its own, without the editor barrel's DOM dependencies —
 *  which is what makes `Uri` testable under vitest's node environment. */
declare module 'monaco-editor/esm/vs/base/common/uri.js' {
  import type { Uri } from 'monaco-editor';
  export const URI: typeof Uri;
}

declare module 'monaco-editor/esm/vs/common/initialize.js' {
  export function initialize(factory: (ctx: unknown, createData: unknown) => unknown): void;
}

declare module 'monaco-editor/esm/vs/language/typescript/tsWorker.js' {
  export interface TsTextSpan {
    start: number;
    length: number;
  }
  export interface TsDefinitionInfo {
    fileName: string;
    textSpan: TsTextSpan;
    name?: string;
    kind?: string;
    containerName?: string;
  }
  export interface TsReferenceEntry {
    fileName: string;
    textSpan: TsTextSpan;
    isWriteAccess?: boolean;
    isDefinition?: boolean;
  }
  /** What `TypeScriptWorker.clearFiles` leaves of a `ts.Diagnostic`: the span survives and
   *  `file` is reduced to its name. */
  export interface TsDiagnostic {
    code: number;
    start?: number;
    length?: number;
    messageText?: unknown;
    file?: { fileName: string };
  }
  /** One entry of the worker's extraLib map, keyed by the file's URI string. */
  export interface TsExtraLib {
    content: string;
    version: number;
  }
  /** The slice of `ts.LanguageService` the extra worker methods delegate to. */
  export interface TsLanguageService {
    getTypeDefinitionAtPosition(fileName: string, position: number): TsDefinitionInfo[] | undefined;
    getImplementationAtPosition(fileName: string, position: number): TsDefinitionInfo[] | undefined;
  }
  export class TypeScriptWorker {
    constructor(ctx: unknown, createData: unknown);
    protected _languageService: TsLanguageService;
    /** Replaced wholesale by `updateExtraLibs`, never mutated in place. */
    protected _extraLibs: Record<string, TsExtraLib>;
    /** The single lookup `readFile`, `fileExists` and `getScriptSnapshot` all go through. */
    protected _getScriptText(fileName: string): string | undefined;
    getScriptVersion(fileName: string): string;
    getDefinitionAtPosition(
      fileName: string,
      position: number,
    ): Promise<TsDefinitionInfo[] | undefined>;
    getReferencesAtPosition(
      fileName: string,
      position: number,
    ): Promise<TsReferenceEntry[] | undefined>;
    getSemanticDiagnostics(fileName: string): Promise<TsDiagnostic[]>;
  }
}
