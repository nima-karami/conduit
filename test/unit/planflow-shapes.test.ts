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
});
