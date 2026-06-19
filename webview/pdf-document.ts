import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist/types/src/display/api';
import { base64ToUint8Array } from './pdf-find';
import './pdf-setup';

/** A flattened outline entry the sidebar renders. `pageIndex` is resolved (0-based) when
 *  the destination points at a concrete page, else null (the click is then a no-op). */
export interface OutlineNode {
  title: string;
  pageIndex: number | null;
  children: OutlineNode[];
}

/** The reason a load failed, mapped to a user-facing notice by the viewer. */
export type PdfLoadError = 'password' | 'corrupt';

export class PdfLoadException extends Error {
  constructor(readonly kind: PdfLoadError) {
    super(kind);
    this.name = 'PdfLoadException';
  }
}

/**
 * Thin wrapper over pdf.js's `PDFDocumentProxy`. The seam the viewer component and the
 * find controller share, and the unit-test boundary: everything the UI needs (page
 * count, a page proxy, page text, the resolved outline) goes through here so the
 * component never touches raw pdf.js types directly.
 */
export class PdfDocument {
  private constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly task: PDFDocumentLoadingTask,
  ) {}

  /** Load from a base64 data URL (the `pdf.dataUrl` the host sends). Maps pdf.js's
   *  `PasswordException` / parse failures to a typed {@link PdfLoadException}. */
  static async load(dataUrl: string): Promise<PdfDocument> {
    const data = base64ToUint8Array(dataUrl);
    let task: PDFDocumentLoadingTask;
    try {
      task = getDocument({ data });
    } catch (e) {
      throw mapLoadError(e);
    }
    try {
      const doc = await task.promise;
      return new PdfDocument(doc, task);
    } catch (e) {
      throw mapLoadError(e);
    }
  }

  get numPages(): number {
    return this.doc.numPages;
  }

  getPage(pageNumber: number): Promise<PDFPageProxy> {
    return this.doc.getPage(pageNumber);
  }

  /** Page text as the joined `str` of every text item — the input shape pdf-find expects. */
  async getPageText(pageNumber: number): Promise<string> {
    const page = await this.doc.getPage(pageNumber);
    const tc = await page.getTextContent();
    return tc.items.map((it) => ('str' in it ? it.str : '')).join('');
  }

  /** The document outline, flattened to {@link OutlineNode}s with resolved page indices.
   *  Returns an empty array when the PDF has no outline. */
  async getOutline(): Promise<OutlineNode[]> {
    const raw = await this.doc.getOutline().catch(() => null);
    if (!raw || raw.length === 0) return [];
    const resolve = async (
      items: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>,
    ): Promise<OutlineNode[]> => {
      const out: OutlineNode[] = [];
      for (const it of items) {
        out.push({
          title: it.title,
          pageIndex: await this.destPageIndex(it.dest),
          children: it.items?.length ? await resolve(it.items) : [],
        });
      }
      return out;
    };
    return resolve(raw);
  }

  /** Resolve an outline destination to a 0-based page index, or null when it can't be
   *  resolved (named dest missing, malformed ref). */
  private async destPageIndex(dest: string | unknown[] | null): Promise<number | null> {
    try {
      const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const ref = explicit[0];
      const idx = await this.doc.getPageIndex(
        ref as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      );
      return typeof idx === 'number' ? idx : null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    // The loading task owns teardown (aborts network/worker); destroying it cascades to
    // the document proxy.
    this.task.destroy().catch(() => {});
  }
}

function mapLoadError(e: unknown): PdfLoadException {
  // pdf.js throws PasswordException for encrypted PDFs; its `name` is the reliable
  // discriminator across bundled/minified builds.
  const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : '';
  if (name === 'PasswordException') return new PdfLoadException('password');
  return new PdfLoadException('corrupt');
}
