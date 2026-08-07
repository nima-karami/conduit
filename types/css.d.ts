/**
 * Side-effect CSS imports (`import './styles.css'`) are resolved by esbuild, not tsc.
 * TypeScript 7 stopped tolerating them implicitly (TS2882), so the module shape is
 * declared once here and the file is listed in BOTH tsconfigs — the host program pulls
 * webview modules in through their unit tests, so a declaration living under `webview/`
 * would only satisfy one of the two.
 */
declare module '*.css';
