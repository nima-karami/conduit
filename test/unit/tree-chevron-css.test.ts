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

describe('tree header stylesheet', () => {
  it('old header chevron, tag and home-fill rules are deleted', () => {
    for (const gone of [
      'files__bar-chev',
      'repo-head__chev',
      'files__tag',
      '.repo-head--home',
      '.repo-head--active .repo-head__sub',
    ]) {
      expect(CSS, gone).not.toContain(gone);
    }
  });

  it('.files__bar no longer justifies its content', () => {
    const bodies = bodiesOf(CSS, '.files__bar');
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join('')).not.toContain('justify-content');
  });
});
