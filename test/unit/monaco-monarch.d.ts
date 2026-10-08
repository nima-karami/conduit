/**
 * Monaco's Monarch compiler and tokenizer ship no type declarations; the grammar units drive them
 * directly (test/unit/grammar-runner.ts), so their shape is declared once here.
 */
declare module 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js' {
  export function compile(languageId: string, json: object): object;
}

declare module 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js' {
  export class MonarchTokenizer {
    constructor(
      languageService: object,
      standaloneThemeService: object,
      languageId: string,
      lexer: object,
      configurationService: object,
    );
    getInitialState(): unknown;
    tokenize(
      line: string,
      hasEOL: boolean,
      state: unknown,
    ): { tokens: { offset: number; type: string }[]; endState: unknown };
  }
}
