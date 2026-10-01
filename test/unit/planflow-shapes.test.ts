import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FlowShape } from '../../src/mermaid-flow';

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');

const SHAPES: FlowShape[] = [
  'rect',
  'round',
  'stadium',
  'subroutine',
  'diamond',
  'circle',
  'cylinder',
  'hexagon',
];

/** The declarations of the rule(s) whose whole selector is `.planflow__node--<shape>`. */
function treatment(shape: FlowShape): string {
  // Preceded by the end of a rule or of a comment, so a compound selector never counts.
  const re = new RegExp(`(?:^|[}/])\\s*\\.planflow__node--${shape}\\s*\\{([^}]*)\\}`, 'g');
  return [...CSS.matchAll(re)].map((m) => m[1].replace(/\s+/g, ' ').trim()).join(' ');
}

describe('flow editor node shapes', () => {
  it('each of the eight shapes draws differently, independent of the theme radius tokens', () => {
    const drawn = SHAPES.map((s) => [s, treatment(s)] as const);
    for (const [shape, css] of drawn.slice(1)) {
      expect(css, `.planflow__node--${shape} has no rule`).not.toBe('');
      expect(css, `${shape} must not hang on a radius token a theme can zero`).not.toMatch(
        /var\(--r-/,
      );
    }
    const unique = new Set(drawn.map(([, css]) => css));
    expect(unique.size).toBe(SHAPES.length);
  });

  it('rect is nearly square-cornered and round clearly rounded, in every theme', () => {
    const radius = (shape: FlowShape) => /border-radius:\s*(\d+)px/.exec(treatment(shape))?.[1];
    expect(Number(radius('rect'))).toBeLessThanOrEqual(3);
    expect(Number(radius('round'))).toBeGreaterThanOrEqual(8);
  });

  it('the diamond is a true diamond drawn behind an upright, unclipped label', () => {
    const pseudo = (which: string) =>
      new RegExp(`\\.planflow__node--diamond::${which}[^{]*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    expect(pseudo('before')).toMatch(
      /clip-path:\s*polygon\(50% 0%?, 100% 50%, 50% 100%, 0%? 50%\)/,
    );
    expect(treatment('diamond')).not.toMatch(/clip-path|rotate/);
  });

  it('node outlines use a stroke strong enough to read on the canvas, not the faint border tiers', () => {
    const base = /(?:^|[}/])\s*\.planflow__node\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    const stroke = /--planflow-stroke:\s*var\((--[a-z0-9-]+)\)/.exec(base)?.[1];
    expect(stroke).toBeDefined();
    expect(['--border', '--border-2']).not.toContain(stroke);
  });
});
