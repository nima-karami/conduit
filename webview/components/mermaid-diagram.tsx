import mermaid from 'mermaid';
import { useEffect, useId, useRef, useState } from 'react';
import { buildMermaidConfig } from '../mermaid-theme';
import { useSettings } from '../settings';

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
  // Fold the active theme into the render id so a theme switch produces a fresh
  // diagram id — the effect re-runs (recolouring the diagram to match the UI) and the
  // dependency is genuine rather than an unused "re-run on external change" marker.
  const { settings } = useSettings();
  const diagramId = `mermaid-${id}-${settings.theme}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

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
  }, [source, diagramId]);

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
    <div
      ref={containerRef}
      className="mermaid-diagram"
      // SVG from mermaid.render under securityLevel:'strict' — script execution is disabled.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid renders SVG under strict securityLevel
      dangerouslySetInnerHTML={{ __html: svgHtml }}
    />
  );
}
