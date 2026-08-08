import mermaid from 'mermaid';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconGraph, IconZoomIn } from '../icons';
import {
  INLINE_MAX_HEIGHT_FRACTION,
  type InlineScaleResult,
  inlineDiagramScale,
  MIN_INLINE_SCALE,
} from '../mermaid-scale';
import { buildMermaidConfig } from '../mermaid-theme';
import { useSettings } from '../settings';
import { normalizeSvgForZoom } from '../svg-normalize';
import { type Size, svgViewBoxSize } from '../svg-viewbox';
import { EmptyState } from './empty-state';
import { MermaidZoomOverlay } from './mermaid-zoom-overlay';

/** True when `className` identifies a mermaid fenced block. Tolerates rehype-highlight's
 *  extra classes by matching the `language-mermaid` token. */
export function isMermaidCodeBlock(className: string | undefined): boolean {
  if (!className) return false;
  return className.split(/\s+/).includes('language-mermaid');
}

interface MermaidProps {
  source: string;
}

interface InlineFit {
  result: InlineScaleResult;
  maxHeight: number;
}

export function MermaidDiagram({ source }: MermaidProps) {
  const id = useId().replace(/:/g, '_');
  const diagramId = `mermaid-${id}`;
  const { settings } = useSettings();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const naturalRef = useRef<{ src: string | null; size: Size }>({
    src: null,
    size: { w: 0, h: 0 },
  });
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [fit, setFit] = useState<InlineFit | null>(null);
  const [column, setColumn] = useState({ width: 0, maxHeight: 0 });

  const isEmpty = source.trim().length === 0;
  // Mermaid emits the root <svg> with width="100%" and an inline max-width, which pins the
  // diagram to the column at any aspect ratio (spec §2 D1/D2). Stripping those is what lets
  // the size below actually apply — same normaliser the zoom overlay uses.
  const inlineSvg = useMemo(
    () => (svgHtml == null ? null : normalizeSvgForZoom(svgHtml)),
    [svgHtml],
  );

  // settings.theme is a dependency biome can't infer: the palette is read live off
  // <html> inside the rAF below (not referenced by value), so a theme switch must
  // re-run this effect to recolour the diagram.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme drives the live-read palette
  useEffect(() => {
    setSvgHtml(null);
    setRenderError(null);
    setFit(null);
    // Empty/whitespace-only fences never reach mermaid.render (it rejects '' as a parse
    // error); the empty affordance is rendered below instead.
    if (isEmpty) return;

    let cancelled = false;
    // rAF so SettingsProvider's data-theme attribute is applied before we read CSS
    // vars (mirrors terminal-pane's live re-theme seam). Mermaid config is global;
    // re-initializing before each render keeps every diagram on one consistent theme.
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      mermaid.initialize(buildMermaidConfig(getComputedStyle(document.documentElement)));
      mermaid
        .render(diagramId, source)
        .then(({ svg }) => {
          if (!cancelled) setSvgHtml(svg);
        })
        .catch((err: unknown) => {
          // mermaid.render() throws before its own temp-node cleanup, so the orphan has to
          // go here and not only in the effect cleanup — an error card can sit on screen
          // indefinitely with the node still attached (spec §2 D3).
          document.getElementById(`d${diagramId}`)?.remove();
          if (!cancelled) {
            const msg = err instanceof Error ? err.message : String(err);
            setRenderError(msg);
          }
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      // Also covers the cancelled-render case, where the catch above never runs.
      document.getElementById(`d${diagramId}`)?.remove();
    };
  }, [source, diagramId, settings.theme, isEmpty]);

  // Re-fit when the Markdown column changes width (pane resize, TOC toggle) or the window
  // changes height — the cap is a share of the viewport, which no element resize reports.
  // inlineSvg is the trigger rather than a value: the host node only exists once a diagram
  // has rendered, so the observer has to be installed when it appears.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inlineSvg is when hostRef exists
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const width = host.clientWidth;
      const maxHeight = window.innerHeight * INLINE_MAX_HEIGHT_FRACTION;
      setColumn((prev) =>
        prev.width === width && prev.maxHeight === maxHeight ? prev : { width, maxHeight },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [inlineSvg]);

  // A layout effect, so the size is in the DOM before the browser paints and a diagram
  // never appears at mermaid's size and then snaps (mirrors usePanZoomStage, spec §3 A1).
  useLayoutEffect(() => {
    const svg = wrapRef.current?.querySelector('svg');
    if (!svg || inlineSvg == null || column.width <= 0) return;
    if (naturalRef.current.src !== inlineSvg) {
      let size = svgViewBoxSize(svg.getAttribute('viewBox'));
      if (size.w === 0) {
        // Measured once per SVG on purpose: this reads back the size this effect applied,
        // so re-measuring on every resize would ratchet the diagram down.
        const r = svg.getBoundingClientRect();
        size = { w: r.width || 1, h: r.height || 1 };
      }
      naturalRef.current = { src: inlineSvg, size };
    }
    setFit({
      maxHeight: column.maxHeight,
      result: inlineDiagramScale({
        natural: naturalRef.current.size,
        columnWidth: column.width,
        maxHeight: column.maxHeight,
        minScale: MIN_INLINE_SCALE,
      }),
    });
  }, [inlineSvg, column]);

  if (isEmpty) {
    return <EmptyState variant="inline" icon={<IconGraph size={20} />} title="Empty diagram" />;
  }

  if (renderError != null) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error__msg">{renderError}</div>
        <pre className="mermaid-error__source">{source}</pre>
      </div>
    );
  }

  if (inlineSvg == null || svgHtml == null) {
    return <div className="mermaid-loading" aria-label="Rendering diagram…" />;
  }

  const scrolls = fit?.result.scrolls ?? false;
  // Floor-scaled or height-capped, the overlay is the only way to read the whole diagram,
  // so the way to it stops being a hover secret (spec §3 C4).
  const constrained = scrolls || (fit?.result.capped ?? false);

  return (
    <div
      ref={hostRef}
      className={`mermaid-diagram${constrained ? ' mermaid-diagram--constrained' : ''}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="mermaid-diagram__expand"
        aria-label="Open diagram in zoom viewer"
        onClick={() => setZoomOpen(true)}
      >
        <IconZoomIn size={15} />
      </button>
      {/* The SVG body is a convenience click target; the focusable expand button above
          is the keyboard path. (a11y lint group is disabled repo-wide.) */}
      <div
        ref={wrapRef}
        className="mermaid-diagram__svg"
        style={
          fit
            ? ({
                maxHeight: fit.maxHeight,
                '--mm-w': `${fit.result.width}px`,
                '--mm-h': `${fit.result.height}px`,
              } as React.CSSProperties)
            : undefined
        }
        // Only a wrapper that actually scrolls becomes a tab stop — an unconditional one
        // would put a stop on every diagram in the document (spec §3 C5).
        {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-label': 'Diagram, scrollable' } : {})}
        onClick={() => setZoomOpen(true)}
        // SVG from mermaid.render under securityLevel:'strict' — script execution is disabled.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid renders SVG under strict securityLevel
        dangerouslySetInnerHTML={{ __html: inlineSvg }}
      />
      {zoomOpen && (
        <MermaidZoomOverlay
          svgHtml={svgHtml}
          onClose={() => {
            setZoomOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
