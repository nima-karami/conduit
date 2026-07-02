import { ChevronDown, ChevronUp, PanelLeft, X } from 'lucide-react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FileContentDTO } from '../../src/protocol';
import { IconChevron, IconRotate, IconSearch, IconZoomIn, IconZoomOut } from '../icons';
import { type OutlineNode, PdfDocument, PdfLoadException } from '../pdf-document';
import { PdfFindController, type PdfMatch } from '../pdf-find';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.2;
// Background page-size resolution flushes state at most once per this many pages so a
// several-hundred-page doc doesn't re-render the whole page list once per page (O(n²)).
const DIMS_FLUSH_BATCH = 32;
// Render a page's canvas only when it is within this many viewport heights of the
// visible area; further pages stay as height-correct placeholders (stable scrollbar).
const WINDOW_MARGIN = '1200px 0px';

type FitMode = 'none' | 'width' | 'page';

interface PageDims {
  width: number;
  height: number;
}

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function PdfViewer({ doc }: { doc: FileContentDTO }) {
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseDims, setBaseDims] = useState<PageDims[]>([]); // page sizes at scale 1

  const dataUrl = doc.pdf?.dataUrl;
  const name = doc.path.replace(/\\/g, '/').split('/').pop() ?? doc.path;

  // ── Load the document once. `agentDeck`-absent preview never sets doc.pdf, so the
  //    component isn't even mounted there; this still guards a defensive undefined. ──
  useEffect(() => {
    if (!dataUrl) return;
    let alive = true;
    let loaded: PdfDocument | null = null;
    setPdf(null);
    setError(null);
    PdfDocument.load(dataUrl)
      .then(async (d) => {
        if (!alive) {
          d.destroy();
          return;
        }
        loaded = d;
        const first = await d.getPage(1);
        if (!alive) {
          d.destroy();
          return;
        }
        // Paint immediately off page 1; its size seeds the placeholder height for every
        // not-yet-measured page so the scrollbar stays stable while the rest stream in.
        const vp1 = first.getViewport({ scale: 1 });
        const dims: PageDims[] = new Array(d.numPages).fill({
          width: vp1.width,
          height: vp1.height,
        });
        setBaseDims(dims.slice());
        setPdf(d);
        // Resolve the remaining page sizes in the background, correcting each estimate as
        // it arrives. `alive` (flipped by the cleanup below) also guards a superseded load.
        let dirty = false;
        for (let i = 2; i <= d.numPages; i++) {
          const page = await d.getPage(i);
          if (!alive) return;
          const vp = page.getViewport({ scale: 1 });
          if (vp.width !== dims[i - 1].width || vp.height !== dims[i - 1].height) {
            dims[i - 1] = { width: vp.width, height: vp.height };
            dirty = true;
          }
          if (dirty && (i % DIMS_FLUSH_BATCH === 0 || i === d.numPages)) {
            setBaseDims(dims.slice());
            dirty = false;
          }
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(
          e instanceof PdfLoadException && e.kind === 'password'
            ? `“${name}” is password-protected (unsupported).`
            : `“${name}” could not be opened (corrupt or invalid PDF).`,
        );
      });
    return () => {
      alive = false;
      loaded?.destroy();
    };
  }, [dataUrl, name]);

  if (doc.error) return <div className="viewer__notice">{doc.error}</div>;
  if (error) return <div className="viewer__notice">{error}</div>;
  if (!dataUrl) return <div className="viewer__notice">PDF could not be loaded.</div>;
  if (!pdf) return <div className="viewer__notice">Loading PDF…</div>;

  return <PdfReady pdf={pdf} baseDims={baseDims} />;
}

function PdfReady({ pdf, baseDims }: { pdf: PdfDocument; baseDims: PageDims[] }) {
  const total = pdf.numPages;
  const [outline, setOutline] = useState<OutlineNode[]>([]);

  // The outline is resolved off the typed PdfDocument once the viewer mounts.
  useEffect(() => {
    let alive = true;
    pdf.getOutline().then((o) => {
      if (alive) setOutline(o);
    });
    return () => {
      alive = false;
    };
  }, [pdf]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState<FitMode>('none');
  // Whole-document rotation (0/90/180/270, clockwise). Resets to 0 per doc because
  // PdfReady unmounts during the load→"Loading…" gap, so this useState re-initialises.
  const [rotation, setRotation] = useState(0);
  const [current, setCurrent] = useState(1);
  const [sidebar, setSidebar] = useState(false);
  const [findOpen, setFindOpen] = useState(false);

  // ── Find state ──────────────────────────────────────────────────────────────
  const findRef = useRef(new PdfFindController());
  const [pageTexts, setPageTexts] = useState<string[] | null>(null);
  const [activeMatch, setActiveMatch] = useState<PdfMatch | null>(null);
  const [findStats, setFindStats] = useState({ ordinal: 0, count: 0 });
  const [query, setQuery] = useState('');

  // Lazily extract all page text the first time find opens (needed for cross-page search).
  useEffect(() => {
    if (!findOpen || pageTexts) return;
    let alive = true;
    (async () => {
      const texts: string[] = [];
      for (let i = 1; i <= total; i++) texts.push(await pdf.getPageText(i));
      if (alive) setPageTexts(texts);
    })();
    return () => {
      alive = false;
    };
  }, [findOpen, pageTexts, pdf, total]);

  const scrollToPage = useCallback((index1: number, smooth = true) => {
    const el = pageRefs.current[index1 - 1];
    if (!el) return;
    el.scrollIntoView({
      behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
      block: 'start',
    });
  }, []);

  const stepFind = useCallback(
    (dir: 1 | -1) => {
      const m = dir === 1 ? findRef.current.next() : findRef.current.prev();
      setActiveMatch(m);
      setFindStats({ ordinal: findRef.current.activeOrdinal, count: findRef.current.count });
      if (m) scrollToPage(m.page + 1);
    },
    [scrollToPage],
  );

  // Searching is driven entirely off `query` + the extracted `pageTexts`, so a query
  // typed before text finished extracting still resolves once the text arrives. The
  // input only calls setQuery; this effect owns the actual search + scroll-to-first.
  useEffect(() => {
    if (!pageTexts || !query) {
      setActiveMatch(null);
      setFindStats({ ordinal: 0, count: 0 });
      return;
    }
    const matches = findRef.current.search(pageTexts, query);
    const first = matches[0] ?? null;
    setActiveMatch(first);
    setFindStats({ ordinal: findRef.current.activeOrdinal, count: findRef.current.count });
    if (first) scrollToPage(first.page + 1);
  }, [pageTexts, query, scrollToPage]);

  // ── Fit modes recompute scale from the container width/height ────────────────
  const applyFit = useCallback(
    (mode: FitMode) => {
      setFit(mode);
      const container = scrollRef.current;
      const first = baseDims[0];
      if (!container || !first) return;
      // Fit reasons about on-screen bounds, so swap w/h at 90°/270°.
      const pw = rotation % 180 === 0 ? first.width : first.height;
      const ph = rotation % 180 === 0 ? first.height : first.width;
      if (mode === 'width') {
        const avail = container.clientWidth - 48; // page margins
        setScale(clampScale(avail / pw));
      } else if (mode === 'page') {
        const aw = (container.clientWidth - 48) / pw;
        const ah = (container.clientHeight - 48) / ph;
        setScale(clampScale(Math.min(aw, ah)));
      }
    },
    [baseDims, rotation],
  );

  const zoomBy = useCallback((delta: number) => {
    setFit('none');
    setScale((s) => clampScale(s + delta));
  }, []);

  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  // Keep an active fit correct after the orientation flips (the fit scale is
  // orientation-dependent). Zoom-only ('none') is left untouched.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fit only when rotation changes.
  useEffect(() => {
    if (fit !== 'none') applyFit(fit);
  }, [rotation]);

  // Track the current page from scroll position (top-most page whose top is above the
  // viewport's upper third). Reads live refs, so the listener never needs re-binding.
  const recomputeCurrent = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const mid = container.scrollTop + container.clientHeight * 0.3;
    let best = 1;
    for (let i = 0; i < pageRefs.current.length; i++) {
      const el = pageRefs.current[i];
      if (el && el.offsetTop <= mid) best = i + 1;
    }
    setCurrent(best);
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.addEventListener('scroll', recomputeCurrent, { passive: true });
    return () => container.removeEventListener('scroll', recomputeCurrent);
  }, [recomputeCurrent]);

  // Page offsets shift when the zoom scale changes, so recompute the active page then.
  // `scale` is read (not just a dep) so the layout-dependent recompute actually re-runs.
  useEffect(() => {
    void scale;
    recomputeCurrent();
  }, [scale, recomputeCurrent]);

  // ── Keyboard: PageUp/Down, Home/End, Ctrl+F, Ctrl +/-, Esc ───────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setFindOpen(true);
        return;
      }
      if (ctrl && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (ctrl && e.key === '-') {
        e.preventDefault();
        zoomBy(-ZOOM_STEP);
        return;
      }
      if (e.key === 'Escape' && findOpen) {
        setFindOpen(false);
        setActiveMatch(null);
        return;
      }
      const container = scrollRef.current;
      if (!container) return;
      if (e.key === 'PageDown') {
        e.preventDefault();
        container.scrollBy({ top: container.clientHeight * 0.9 });
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        container.scrollBy({ top: -container.clientHeight * 0.9 });
      } else if (e.key === 'Home') {
        e.preventDefault();
        scrollToPage(1);
      } else if (e.key === 'End') {
        e.preventDefault();
        scrollToPage(total);
      }
    },
    [findOpen, scrollToPage, total, zoomBy],
  );

  const zoomPct = Math.round(scale * 100);

  return (
    <div className="pdfview" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="pdfview__toolbar">
        <button
          type="button"
          className={`pdfview__btn${sidebar ? ' is-active' : ''}`}
          aria-label="Toggle sidebar"
          aria-pressed={sidebar}
          onClick={() => setSidebar((s) => !s)}
        >
          <PanelLeft size={15} />
        </button>
        <div className="pdfview__group">
          <button
            type="button"
            className="pdfview__btn"
            aria-label="Previous page"
            disabled={current <= 1}
            onClick={() => scrollToPage(Math.max(1, current - 1))}
          >
            <IconChevron size={15} className="pdfview__icon-up" />
          </button>
          <span className="pdfview__pageinfo">
            <PageJump current={current} total={total} onJump={(p) => scrollToPage(p)} />
            <span className="pdfview__pagetotal"> / {total}</span>
          </span>
          <button
            type="button"
            className="pdfview__btn"
            aria-label="Next page"
            disabled={current >= total}
            onClick={() => scrollToPage(Math.min(total, current + 1))}
          >
            <IconChevron size={15} className="pdfview__icon-down" />
          </button>
        </div>
        <div className="pdfview__group">
          <button
            type="button"
            className="pdfview__btn"
            aria-label="Zoom out"
            onClick={() => zoomBy(-ZOOM_STEP)}
          >
            <IconZoomOut size={15} />
          </button>
          <span className="pdfview__zoom">{zoomPct}%</span>
          <button
            type="button"
            className="pdfview__btn"
            aria-label="Zoom in"
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <IconZoomIn size={15} />
          </button>
          <button
            type="button"
            className={`pdfview__btn pdfview__fit${fit === 'width' ? ' is-active' : ''}`}
            aria-label="Fit width"
            aria-pressed={fit === 'width'}
            onClick={() => applyFit('width')}
          >
            Width
          </button>
          <button
            type="button"
            className={`pdfview__btn pdfview__fit${fit === 'page' ? ' is-active' : ''}`}
            aria-label="Fit page"
            aria-pressed={fit === 'page'}
            onClick={() => applyFit('page')}
          >
            Page
          </button>
          <button
            type="button"
            className="pdfview__btn"
            aria-label="Rotate 90 degrees clockwise"
            onClick={rotate}
          >
            <IconRotate size={15} />
          </button>
        </div>
        <button
          type="button"
          className={`pdfview__btn${findOpen ? ' is-active' : ''}`}
          aria-label="Find"
          aria-pressed={findOpen}
          onClick={() => setFindOpen((f) => !f)}
        >
          <IconSearch size={15} />
        </button>
        {findOpen && (
          <FindBox
            query={query}
            stats={findStats}
            ready={pageTexts != null}
            onChange={setQuery}
            onNext={() => stepFind(1)}
            onPrev={() => stepFind(-1)}
            onClose={() => {
              setFindOpen(false);
              setActiveMatch(null);
            }}
          />
        )}
      </div>

      <div className="pdfview__body">
        {sidebar && (
          <Sidebar
            outline={outline}
            total={total}
            pdf={pdf}
            current={current}
            rotation={rotation}
            onGoto={(p) => scrollToPage(p)}
          />
        )}
        <div className="pdfview__scroll" ref={scrollRef}>
          {baseDims.map((dim, i) => (
            <PdfPage
              // biome-ignore lint/suspicious/noArrayIndexKey: pages are a fixed ordered list.
              key={i}
              setPageEl={(el) => {
                pageRefs.current[i] = el;
              }}
              pdf={pdf}
              pageNumber={i + 1}
              dims={dim}
              scale={scale}
              rotation={rotation}
              highlight={activeMatch?.page === i ? query : ''}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function PageJump({
  current,
  total,
  onJump,
}: {
  current: number;
  total: number;
  onJump: (page: number) => void;
}) {
  const [val, setVal] = useState(String(current));
  useEffect(() => setVal(String(current)), [current]);
  const commit = () => {
    const n = Number.parseInt(val, 10);
    if (Number.isFinite(n) && n >= 1 && n <= total) onJump(n);
    else setVal(String(current));
  };
  return (
    <input
      className="pdfview__jump"
      aria-label="Page number"
      value={val}
      onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function FindBox({
  query,
  stats,
  ready,
  onChange,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  stats: { ordinal: number; count: number };
  ready: boolean;
  onChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const label = !ready ? '…' : query ? `${stats.ordinal}/${stats.count}` : '';
  return (
    <div className="pdfview__find">
      <input
        ref={ref}
        className="pdfview__findinput"
        placeholder="Find in document"
        aria-label="Find in document"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="pdfview__findcount">{label}</span>
      <button
        type="button"
        className="pdfview__btn"
        aria-label="Previous match"
        disabled={stats.count === 0}
        onClick={onPrev}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="pdfview__btn"
        aria-label="Next match"
        disabled={stats.count === 0}
        onClick={onNext}
      >
        <ChevronDown size={14} />
      </button>
      <button type="button" className="pdfview__btn" aria-label="Close find" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

function Sidebar({
  outline,
  total,
  pdf,
  current,
  rotation,
  onGoto,
}: {
  outline: OutlineNode[];
  total: number;
  pdf: PdfDocument;
  current: number;
  rotation: number;
  onGoto: (page: number) => void;
}) {
  const [tab, setTab] = useState<'outline' | 'thumbs'>('outline');
  return (
    <div className="pdfview__sidebar">
      <div className="pdfview__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'outline'}
          className={`pdfview__tab${tab === 'outline' ? ' is-active' : ''}`}
          onClick={() => setTab('outline')}
        >
          Outline
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'thumbs'}
          className={`pdfview__tab${tab === 'thumbs' ? ' is-active' : ''}`}
          onClick={() => setTab('thumbs')}
        >
          Thumbnails
        </button>
      </div>
      {tab === 'outline' ? (
        outline.length === 0 ? (
          <div className="pdfview__empty">No outline</div>
        ) : (
          <ul className="pdfview__outline">
            {outline.map((node, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: outline is a fixed ordered tree.
              <OutlineItem key={i} node={node} depth={0} onGoto={onGoto} />
            ))}
          </ul>
        )
      ) : (
        <Thumbnails total={total} pdf={pdf} current={current} rotation={rotation} onGoto={onGoto} />
      )}
    </div>
  );
}

function OutlineItem({
  node,
  depth,
  onGoto,
}: {
  node: OutlineNode;
  depth: number;
  onGoto: (page: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="pdfview__outitem"
        style={{ paddingLeft: 8 + depth * 12 }}
        disabled={node.pageIndex == null}
        onClick={() => node.pageIndex != null && onGoto(node.pageIndex + 1)}
      >
        {node.title}
      </button>
      {node.children.length > 0 && (
        <ul className="pdfview__outline">
          {node.children.map((child, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: outline is a fixed ordered tree.
            <OutlineItem key={i} node={child} depth={depth + 1} onGoto={onGoto} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Thumbnails({
  total,
  pdf,
  current,
  rotation,
  onGoto,
}: {
  total: number;
  pdf: PdfDocument;
  current: number;
  rotation: number;
  onGoto: (page: number) => void;
}) {
  return (
    <div className="pdfview__thumbs">
      {Array.from({ length: total }, (_, i) => (
        <Thumb
          // biome-ignore lint/suspicious/noArrayIndexKey: pages are a fixed ordered list.
          key={i}
          pdf={pdf}
          pageNumber={i + 1}
          active={current === i + 1}
          rotation={rotation}
          onClick={() => onGoto(i + 1)}
        />
      ))}
    </div>
  );
}

function Thumb({
  pdf,
  pageNumber,
  active,
  rotation,
  onClick,
}: {
  pdf: PdfDocument;
  pageNumber: number;
  active: boolean;
  rotation: number;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const holderRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: ReturnType<PDFPageProxy['render']> | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const target = 120;
      // rotation is additive to the page's intrinsic rotation (getViewport's `rotation`
      // is absolute, defaulting to page.rotate).
      const spin = (page.rotate + rotation) % 360;
      const vp1 = page.getViewport({ scale: 1, rotation: spin });
      const scale = target / vp1.width;
      const vp = page.getViewport({ scale, rotation: spin });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      task = page.render({ canvas, canvasContext: ctx, viewport: vp });
      await task.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, pdf, pageNumber, rotation]);

  return (
    <button
      ref={holderRef}
      type="button"
      className={`pdfview__thumb${active ? ' is-active' : ''}`}
      aria-label={`Go to page ${pageNumber}`}
      onClick={onClick}
    >
      <canvas ref={canvasRef} className="pdfview__thumbcanvas" />
      <span className="pdfview__thumbnum">{pageNumber}</span>
    </button>
  );
}

interface TextItemLayout {
  str: string;
  left: number;
  top: number;
  fontSize: number;
  scaleX: number;
  /** Text run angle in radians (non-zero under rotation or slanted text). */
  angle: number;
}

/** Multiply two pdf.js affine transforms [a b c d e f] (== pdf.js Util.transform). */
function mulTransform(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const PdfPage = ({
  setPageEl,
  pdf,
  pageNumber,
  dims,
  scale,
  rotation,
  highlight,
}: {
  setPageEl: (el: HTMLDivElement | null) => void;
  pdf: PdfDocument;
  pageNumber: number;
  dims: PageDims;
  scale: number;
  /** Whole-document rotation in degrees (0/90/180/270), added to page.rotate. */
  rotation: number;
  /** When non-empty, text-layer items containing this needle (case-insensitive) get the
   *  find-highlight class. Empty on pages without the active match. */
  highlight: string;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  const [items, setItems] = useState<TextItemLayout[] | null>(null);
  const reactId = useId();

  // Windowing: only mount the canvas + text layer when the page is near the viewport.
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { rootMargin: WINDOW_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: ReturnType<PDFPageProxy['render']> | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      // rotation is additive to the page's intrinsic rotation (getViewport's `rotation`
      // is absolute, defaulting to page.rotate). The viewport's width/height/transform
      // already account for it, so the canvas + text-layer geometry derive from it.
      const spin = (page.rotate + rotation) % 360;
      const vp = page.getViewport({ scale, rotation: spin });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(vp.width * dpr);
      canvas.height = Math.ceil(vp.height * dpr);
      canvas.style.width = `${Math.ceil(vp.width)}px`;
      canvas.style.height = `${Math.ceil(vp.height)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      task = page.render({ canvas, canvasContext: ctx, viewport: vp });
      await task.promise.catch(() => {});

      const tc = await page.getTextContent();
      if (cancelled) return;
      // The text-layer spans render in a fallback UI font (the PDF's embedded font isn't
      // loaded), so measure against that same inherited family to get each run's natural
      // width for the stretch ratio below.
      const fontFamily = holderRef.current
        ? getComputedStyle(holderRef.current).fontFamily
        : 'sans-serif';
      const layout: TextItemLayout[] = [];
      for (const it of tc.items) {
        if (!('str' in it) || !it.str) continue;
        // Compose the item's PDF-space transform with the viewport transform so scale AND
        // rotation are baked into device (CSS top-left) space in one step; the span's
        // left/top/angle then read straight off the result.
        const m = mulTransform(vp.transform, it.transform);
        const angle = Math.atan2(m[1], m[0]);
        const fontSize = Math.hypot(m[2], m[3]);
        // Offset the origin by the ascent (approximated as the full font height, since the
        // fallback font is stretched via scaleX) along the run direction, matching pdf.js's
        // own text-layer placement. Reduces to `top = m[5] - fontSize` at angle 0.
        const left = m[4] + (angle === 0 ? 0 : fontSize * Math.sin(angle));
        const top = m[5] - fontSize * Math.cos(angle);
        // Ratio that stretches the fallback-font run to the width pdf.js reports, so the
        // invisible selectable glyphs line up with the canvas glyphs (proportional/
        // justified text otherwise drifts). measureText ignores the ctx transform.
        ctx.font = `${fontSize}px ${fontFamily}`;
        const naturalWidth = ctx.measureText(it.str).width;
        layout.push({
          str: it.str,
          left,
          top,
          fontSize,
          angle,
          scaleX: naturalWidth > 0 ? (it.width * scale) / naturalWidth : 1,
        });
      }
      setItems(layout);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, pdf, pageNumber, scale, rotation]);

  const rotated = rotation % 180 !== 0;
  const w = Math.ceil((rotated ? dims.height : dims.width) * scale);
  const h = Math.ceil((rotated ? dims.width : dims.height) * scale);

  return (
    <div
      ref={(el) => {
        holderRef.current = el;
        setPageEl(el);
      }}
      className="pdfview__page"
      style={{ width: w, height: h }}
      data-page={pageNumber}
    >
      {near ? (
        <>
          <canvas ref={canvasRef} className="pdfview__canvas" />
          <div className="textLayer" aria-hidden={false}>
            {items?.map((it, i) => {
              const isMatch =
                highlight !== '' && it.str.toLowerCase().includes(highlight.toLowerCase());
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: items are a fixed ordered list per render.
                  key={`${reactId}-${i}`}
                  className={isMatch ? 'pdfview__hl' : undefined}
                  style={{
                    left: it.left,
                    top: it.top,
                    fontSize: it.fontSize,
                    transform: `rotate(${it.angle}rad) scaleX(${it.scaleX})`,
                  }}
                >
                  {it.str}
                </span>
              );
            })}
          </div>
        </>
      ) : (
        <div className="pdfview__placeholder" />
      )}
    </div>
  );
};
