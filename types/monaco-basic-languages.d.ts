/**
 * Monaco's ESM grammar modules (`basic-languages/<lang>/<lang>.js`) ship no type
 * declarations — only their `*.contribution.d.ts` siblings do. We import them directly to
 * register tokenizers synchronously (webview/monaco-languages.ts), so their shape is
 * declared once here rather than silenced at each import.
 *
 * Every one of these modules is generated to the same shape: a Monarch language definition
 * plus its editor configuration. Explicit declarations elsewhere (the `.contribution`
 * modules) still win over this pattern.
 */
declare module 'monaco-editor/esm/vs/basic-languages/*' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
