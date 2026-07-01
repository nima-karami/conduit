// Pure/reusable export helpers for a rendered mermaid SVG. Kept out of the overlay so the
// blob/filename logic is unit-testable; the DOM-bound helpers (PNG raster, download) run
// only in the renderer and are covered by test/e2e/mermaid-export.e2e.mjs. See
// docs/specs/2026-07-01-mermaid-export.md.

import { svgViewBoxSize } from './svg-viewbox';

const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Turn mermaid's raw SVG markup into a standalone document: guarantee an `xmlns` and an
 * XML prolog so the saved file opens outside a browser. Idempotent — never doubles a
 * prolog or namespace that's already present.
 */
export function normalizeSvgMarkup(svgHtml: string): string {
  let out = svgHtml.trim();
  if (!/<svg\b[^>]*\sxmlns=/.test(out)) {
    out = out.replace(/<svg\b/, `<svg xmlns="${SVG_NS}"`);
  }
  if (!out.startsWith('<?xml')) {
    out = XML_PROLOG + out;
  }
  return out;
}

export function svgToBlob(svgHtml: string): Blob {
  return new Blob([normalizeSvgMarkup(svgHtml)], { type: 'image/svg+xml' });
}

/**
 * Rasterize the SVG to a PNG blob at `scale`× the intrinsic size. Rejects if the diagram
 * has no determinable size, the SVG image fails to load, or the canvas has no 2D context.
 */
export async function svgToPngBlob(svgHtml: string, scale = 2): Promise<Blob> {
  const normalized = normalizeSvgMarkup(svgHtml);
  const doc = new DOMParser().parseFromString(normalized, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) throw new Error('mermaid-export: no <svg> element to rasterize');

  // mermaid sizes diagrams by viewBox (width is often a percentage), so read the viewBox
  // first and fall back to explicit width/height before giving up.
  let size = svgViewBoxSize(svg.getAttribute('viewBox'));
  if (size.w === 0) {
    const w = Number.parseFloat(svg.getAttribute('width') ?? '');
    const h = Number.parseFloat(svg.getAttribute('height') ?? '');
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) size = { w, h };
  }
  if (size.w === 0 || size.h === 0) {
    throw new Error('mermaid-export: could not determine diagram size');
  }

  svg.setAttribute('width', String(size.w));
  svg.setAttribute('height', String(size.h));

  const serialized = new XMLSerializer().serializeToString(svg);
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('mermaid-export: SVG image failed to load'));
    img.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.w * scale));
  canvas.height = Math.max(1, Math.round(size.h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('mermaid-export: 2D canvas context unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('mermaid-export: canvas.toBlob returned null'));
    }, 'image/png');
  });
}

export function diagramFilename(ext: string, stem = 'diagram'): string {
  return `${stem}.${ext.replace(/^\./, '')}`;
}

/**
 * Trigger a browser download of `blob` as `filename`. There is no host save-dialog IPC —
 * Chromium-in-Electron handles the save via a synthetic `<a download>` click.
 */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
