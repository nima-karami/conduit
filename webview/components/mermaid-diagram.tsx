import mermaid from 'mermaid';
import { useEffect, useId, useRef, useState } from 'react';

// strict security disables script execution in rendered SVG (see the noDangerouslySetInnerHtml
// ignore below). Calling initialize repeatedly is safe — it merges config.
mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, theme: 'dark' });

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
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvgHtml(null);
    setRenderError(null);

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

    return () => {
      cancelled = true;
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
