import mermaid from 'mermaid';
import { useEffect, useId, useRef, useState } from 'react';
import { IconGraph, IconZoomIn } from '../icons';
import { buildMermaidConfig } from '../mermaid-theme';
import { useSettings } from '../settings';
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

export function MermaidDiagram({ source }: MermaidProps) {
  const id = useId().replace(/:/g, '_');
  const diagramId = `mermaid-${id}`;
  const { settings } = useSettings();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);

  const isEmpty = source.trim().length === 0;

  // settings.theme is a dependency biome can't infer: the palette is read live off
  // <html> inside the rAF below (not referenced by value), so a theme switch must
  // re-run this effect to recolour the diagram.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme drives the live-read palette
  useEffect(() => {
    setSvgHtml(null);
    setRenderError(null);
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
          if (!cancelled) {
            const msg = err instanceof Error ? err.message : String(err);
            setRenderError(msg);
          }
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      // On a parse error mermaid.render() throws before its own temp-node cleanup runs,
      // leaving the offscreen <div id="d<id>"> it appends to <body>. Remove it here so
      // theme-switch re-renders and unmount don't accumulate orphan nodes.
      document.getElementById(`d${diagramId}`)?.remove();
    };
  }, [source, diagramId, settings.theme, isEmpty]);

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

  if (svgHtml == null) {
    return <div className="mermaid-loading" aria-label="Rendering diagram…" />;
  }

  return (
    <div className="mermaid-diagram">
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
        className="mermaid-diagram__svg"
        onClick={() => setZoomOpen(true)}
        // SVG from mermaid.render under securityLevel:'strict' — script execution is disabled.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid renders SVG under strict securityLevel
        dangerouslySetInnerHTML={{ __html: svgHtml }}
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
