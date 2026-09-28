import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ' ',
);

/** Bodies of every top-level-or-nested rule whose selector list is exactly `selector`. */
const bodiesOf = (css: string, selector: string) =>
  [...css.matchAll(/([^{};}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].trim() === selector)
    .map((m) => m[2]);

/** Contents of every `@media <query> { … }` block (one level of nesting). */
const mediaBlocks = (query: string) =>
  [...CSS.matchAll(/@media\s*([^{]+)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)]
    .filter((m) => m[1].trim() === query)
    .map((m) => m[2]);

describe('tree chevron stylesheet', () => {
  it('the old row chevron rules are deleted', () => {
    expect(CSS).not.toContain('filerow__chev');
  });

  it('.treechev rotates 90deg when open and snaps under reduced motion', () => {
    expect(bodiesOf(CSS, '.treechev--open').join('')).toMatch(/transform:\s*rotate\(90deg\)/);
    const reduced = mediaBlocks('(prefers-reduced-motion: reduce)').flatMap((b) =>
      bodiesOf(b, '.treechev'),
    );
    expect(reduced.join('')).toMatch(/transition:\s*none/);
  });
});
