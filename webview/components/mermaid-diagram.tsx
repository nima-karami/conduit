import mermaid from 'mermaid';
import { useEffect, useId, useRef, useState } from 'react';
import { IconZoomIn } from '../icons';
import { buildMermaidConfig } from '../mermaid-theme';
import { useSettings } from '../settings';
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

  // settings.theme is a dependency biome can't infer: the palette is read live off
  // <html> inside the rAF below (not referenced by value), so a theme switch must
  // re-run this effect to recolour the diagram.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme drives the live-read palette
  useEffect(() => {
    let cancelled = false;
    setSvgHtml(null);
    setRenderError(null);

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
    };
  }, [source, diagramId, settings.theme]);

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
