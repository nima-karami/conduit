import { GlobalWorkerOptions } from 'pdfjs-dist';

// pdf.js needs its worker; we bundle it separately to out/pdf.worker.js (esbuild, see
// esbuild.mjs) exactly like the Monaco workers, and reference it the same way
// monaco-setup.ts does (`new Worker('./pdf.worker.js')`) so it resolves under the
// file:// renderer without a hardcoded CDN.
//
// We construct the Worker ourselves and hand pdf.js a `workerPort` rather than setting
// `workerSrc`. Under a file:// document, pdf.js treats the worker URL as cross-origin
// (file origin is "null") and would wrap it in a `blob:`/dynamic-import shim — which the
// renderer CSP (`worker-src 'self'`) blocks. A self-created same-path module Worker side-
// steps that wrapper entirely. The bundle is an ES module → `{ type: 'module' }`.
//
// Imported once before the first getDocument; idempotent (the port is created once).
if (!GlobalWorkerOptions.workerPort) {
  GlobalWorkerOptions.workerPort = new Worker(new URL('./pdf.worker.js', document.baseURI), {
    type: 'module',
  });
}
