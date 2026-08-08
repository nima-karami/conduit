import { GlobalWorkerOptions, PDFWorker } from 'pdfjs-dist';

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

let worker: PDFWorker | null = null;

/**
 * The worker every document loads through. `getDocument` without an explicit `worker`
 * adopts the shared port into the loading task itself, so the `task.destroy()` a document
 * switch runs tears the port down for every later load — which surfaced as "corrupt or
 * invalid PDF". Owning the PDFWorker here keeps teardown per-task (spec §2 D11).
 *
 * Built on first call, not at import: this module is reachable from the app bundle's
 * static import graph, so doing it at module scope spawned the worker and ran its
 * handshake on every launch, PDF or no PDF.
 */
export function getPdfWorker(): PDFWorker {
  if (!worker) {
    const port =
      GlobalWorkerOptions.workerPort ??
      new Worker(new URL('./pdf.worker.js', document.baseURI), { type: 'module' });
    GlobalWorkerOptions.workerPort = port;
    // `create` is port-keyed, so this is the same instance pdf.js would have made.
    worker = PDFWorker.create({ port });
  }
  return worker;
}
