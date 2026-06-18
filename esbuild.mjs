import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

// Electron main process.
const main = {
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'out/main.js',
  platform: 'node',
  format: 'cjs',
  external: ['electron', '@lydell/node-pty'],
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

// Renderer (React + xterm). Imported CSS is emitted as out/webview.css.
const web = {
  ...common,
  entryPoints: ['webview/index.tsx'],
  outfile: 'out/webview.js',
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  // .ttf = Monaco's codicon font; .woff/.woff2 = KaTeX math fonts (referenced by
  // katex.min.css). Without these loaders esbuild errors on the font url()s.
  loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
};

// Monaco's editor worker (diff/colorization) + the TypeScript/JavaScript language
// worker (powers go-to-definition, hover, references).
const monacoWorker = {
  ...common,
  entryPoints: {
    'monaco-editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js',
    'ts.worker': 'monaco-editor/esm/vs/language/typescript/ts.worker.js',
  },
  outdir: 'out',
  platform: 'browser',
  format: 'iife',
};

const indexHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; worker-src 'self'; connect-src 'self';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="./icon.png">
<link rel="stylesheet" href="./webview.css">
<style>html,body{margin:0;height:100vh;background:#0c0d10;overflow:hidden;}</style>
</head>
<body><div id="root"></div><script src="./webview.js"></script></body>
</html>`;

function writeHtml() {
  mkdirSync('out', { recursive: true });
  writeFileSync('out/index.html', indexHtml);
  // Copy app icon into the renderer bundle so it's available as ./icon.png
  copyFileSync('assets/icon.png', 'out/icon.png');
}

if (watch) {
  const ctxs = await Promise.all([main, preload, web, monacoWorker].map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  writeHtml();
} else {
  await Promise.all([main, preload, web, monacoWorker].map((c) => esbuild.build(c)));
  writeHtml();
}
