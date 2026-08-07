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
  /** The slice of `ts.LanguageService` the extra worker methods delegate to. */
  export interface TsLanguageService {
    getTypeDefinitionAtPosition(fileName: string, position: number): TsDefinitionInfo[] | undefined;
    getImplementationAtPosition(fileName: string, position: number): TsDefinitionInfo[] | undefined;
  }
  export class TypeScriptWorker {
    constructor(ctx: unknown, createData: unknown);
    protected _languageService: TsLanguageService;
    getDefinitionAtPosition(
      fileName: string,
      position: number,
    ): Promise<TsDefinitionInfo[] | undefined>;
  }
}
