import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { monacoDompurify } from './tools/monaco-dompurify.mjs';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

// Electron main process.
const main = {
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'out/main.js',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
};

// Electron preload (runs in the renderer with Node access, bridges via contextBridge).
const preload = {
  ...common,
  entryPoints: ['electron/preload.ts'],
  outfile: 'out/preload.js',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
};

const contentSearchWorker = {
  ...common,
  entryPoints: ['src/content-search-worker.ts'],
  outfile: 'out/content-search-worker.js',
  platform: 'node',
  format: 'cjs',
};

const serverShell = {
  ...common,
  entryPoints: ['server/main.ts', 'server/supervise.ts'],
  outdir: 'out/server',
  platform: 'node',
  format: 'cjs',
};

// Renderer (React + xterm). Imported CSS is emitted as <out>/webview.css. A function of the output
// dir so test/unit/font-bundle.test.ts can build the real renderer bundle into a temp dir.
export const webBuild = (out = 'out') => ({
  ...common,
  entryPoints: ['webview/index.tsx'],
  outfile: `${out}/webview.js`,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  plugins: [monacoDompurify],
  // Without this esbuild bundles React's development build, which also runs the profiler on every
  // commit (performance.measure per render) and keeps per-fiber debug stacks.
  define: { 'process.env.NODE_ENV': '"production"' },
  // .ttf = Monaco's codicon font and our bundled faces (webview/fonts.css); .woff/.woff2 = KaTeX
  // math fonts (referenced by katex.min.css). Without these loaders esbuild errors on the url()s.
  loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
});
const web = webBuild();

// Monaco's editor worker (diff/colorization) + the TypeScript/JavaScript language
// worker (powers go-to-definition, hover, references). The TS worker is OURS
// (webview/ts.worker.ts) — monaco's, subclassed to add the type-definition and
// implementation methods its worker never exposed.
const monacoWorker = {
  ...common,
  entryPoints: {
    'monaco-editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js',
    'ts.worker': 'webview/ts.worker.ts',
  },
  outdir: 'out',
  platform: 'browser',
  format: 'iife',
};

// pdf.js renders off the main thread in a dedicated worker, bundled separately
// (like the Monaco workers above) so pdf-setup.ts can point GlobalWorkerOptions at
// out/pdf.worker.js. The worker is an ES module (.mjs) → format must be 'esm'.
const pdfWorker = {
  ...common,
  entryPoints: { 'pdf.worker': 'pdfjs-dist/build/pdf.worker.min.mjs' },
  outdir: 'out',
  platform: 'browser',
  format: 'esm',
};

const indexHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; worker-src 'self'; connect-src 'self';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="./icon.png">
<link rel="stylesheet" href="./webview.css">
<!-- No background here: webview.css is render-blocking, so the theme's own ground paints
     on the first frame. A literal colour would out-rank it (this style block comes after
     the sheet) and pin every theme to one near-black. -->
<style>html,body{margin:0;height:100vh;overflow:hidden;}</style>
</head>
<body><div id="root"></div><script src="./webview.js"></script></body>
</html>`;

export function writeHtml(out = 'out') {
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/index.html`, indexHtml);
  // Copy app icons into the renderer bundle so they're available as ./icon.png and (dev
  // builds) ./icon-dev.png — the top bar swaps to the dev-badged logo when about.isDev.
  copyFileSync('assets/icon.png', `${out}/icon.png`);
  copyFileSync('assets/icon-dev.png', `${out}/icon-dev.png`);
  // The OFL travels with the font files esbuild emits into out/ (and so into app.asar).
  copyFileSync('THIRD_PARTY_NOTICES.txt', `${out}/THIRD_PARTY_NOTICES.txt`);
  cpSync('assets/fonts/licenses', `${out}/licenses/fonts`, { recursive: true });
}

const watch = process.argv.includes('--watch');
// Run as a script, not imported. Windows hands back either drive-letter case.
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const invoked =
  !!process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url));
const all = [main, preload, web, monacoWorker, pdfWorker, contentSearchWorker, serverShell];

if (invoked && watch) {
  const ctxs = await Promise.all(all.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  writeHtml();
} else if (invoked) {
  await Promise.all(all.map((c) => esbuild.build(c)));
  writeHtml();
}
