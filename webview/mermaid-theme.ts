import { cssVar } from './css-var';

/**
 * Map the app's CSS design tokens onto Mermaid `themeVariables` so diagrams paint in
 * the active theme instead of Mermaid's built-in palette. Pure (reads only the passed
 * computed style) so it's unit-testable with a fake CSSStyleDeclaration. Every lookup
 * has a hardcoded fallback — an empty themeVariables value makes Mermaid render
 * broken/invisible elements, so a missing var must never produce ''.
 */
export function buildMermaidThemeVariables(cs: CSSStyleDeclaration): Record<string, string> {
  const bg = cssVar(cs, '--bg', '#0c0d10');
  const panel = cssVar(cs, '--panel', '#14171c');
  const panel2 = cssVar(cs, '--panel-2', '#1b1f26');
  const raise = cssVar(cs, '--raise', '#15171c');
  const text = cssVar(cs, '--text', '#e6e6e6');
  const textDim = cssVar(cs, '--text-dim', '#9aa0aa');
  const border = cssVar(cs, '--border', '#2a2e36');
  const border2 = cssVar(cs, '--border-2', border);
  const accent = cssVar(cs, '--accent', '#d9775c');
  const fontFamily = cssVar(cs, '--font-ui', "'Hanken Grotesk', system-ui, sans-serif");

  return {
    background: bg,
    fontFamily,
    // Flowchart nodes
    primaryColor: panel,
    primaryTextColor: text,
    primaryBorderColor: border2,
    secondaryColor: raise,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: panel2,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    mainBkg: panel,
    nodeBorder: border2,
    nodeTextColor: text,
    // Edges + their labels
    lineColor: textDim,
    edgeLabelBackground: bg,
    // Subgraph clusters
    clusterBkg: raise,
    clusterBorder: border,
    // Sequence diagrams
    actorBkg: panel,
    actorBorder: accent,
    actorTextColor: text,
    actorLineColor: textDim,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: raise,
    labelBoxBorderColor: border2,
    labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: panel2,
    noteBorderColor: border2,
    noteTextColor: text,
  };
}

export interface MermaidConfig {
  securityLevel: 'strict';
  startOnLoad: false;
  theme: 'base';
  themeVariables: Record<string, string>;
}

/**
 * Full Mermaid init config keyed to the current theme. `securityLevel:'strict'` is
 * load-bearing — the SVG is injected via dangerouslySetInnerHTML and relies on strict
 * mode disabling script execution; never relax it here.
 */
export function buildMermaidConfig(cs: CSSStyleDeclaration): MermaidConfig {
  return {
    securityLevel: 'strict',
    startOnLoad: false,
    theme: 'base',
    themeVariables: buildMermaidThemeVariables(cs),
  };
}
