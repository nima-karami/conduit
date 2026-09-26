import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * styles.css shares one document with Monaco, so a bare class selector whose name Monaco also
 * uses styles Monaco's element too. Each of these shipped: `.right` (the right pane) stretched
 * the suggest widget's details column over the labels, `.slider` (the settings range) made every
 * editor scrollbar thumb 220px, `.stale` would have covered the problems widget once its marker
 * went stale, `.peek` restyled sticky scroll inside the references peek, `.center` was waiting
 * for the diff editor's hidden-lines bar. A rule may name a Monaco class only when it is
 * theming Monaco on purpose — the selector is anchored on a Monaco widget.
 */

const REPO = join(__dirname, '..', '..');

const blank = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
/** Selector text only: declaration blocks emptied, innermost first, so nested @media unwraps. */
function selectorText(css: string): string {
  let s = blank(css);
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\{[^{}]*\}/g, ';');
  }
  return s;
}
const classesIn = (s: string) => [...s.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]);

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return cssFiles(p);
    return d.name.endsWith('.css') ? [p] : [];
  });
}

const MONACO = new Set(
  cssFiles(join(REPO, 'node_modules', 'monaco-editor', 'esm')).flatMap((f) =>
    classesIn(selectorText(readFileSync(f, 'utf8'))),
  ),
);

/** Classes that only ever sit on Monaco's own widget roots: a selector through one of these is
 *  theming Monaco deliberately. */
const isMonacoAnchor = (c: string) =>
  c.startsWith('monaco-') ||
  ['find-widget', 'reference-zone-widget', 'zone-widget', 'context-view'].includes(c) ||
  c.startsWith('workbench-hover');

/** Split on top-level commas only, so `:is(.a, .b)` stays one selector. */
function splitGroup(group: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of group) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The compound a selector styles — its last one, with :is()/:where() arguments folded in. */
function subjectOf(sel: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  return sel.slice(start);
}

function collisions(): string[] {
  const src = selectorText(readFileSync(join(REPO, 'webview', 'styles.css'), 'utf8'));
  const found: string[] = [];
  for (const group of src.split(';')) {
    const head = group.trim();
    if (!head || head.startsWith('@')) continue;
    for (const sel of splitGroup(head)) {
      if (classesIn(sel).some(isMonacoAnchor)) continue;
      const subject = subjectOf(sel);
      // `:where(...)` restricts what matches; an element qualifier Monaco's element lacks does too.
      const own = subject.replace(/:(where|not)\([^)]*\)/g, '');
      if (/^[a-z]/i.test(own)) continue;
      const cls = classesIn(own);
      if (cls.length > 0 && !/:where\(/.test(subject) && cls.every((c) => MONACO.has(c)))
        found.push(sel);
    }
  }
  return found;
}

describe('styles.css vs Monaco class names', () => {
  it('reads Monaco’s class names (the guard is not vacuous)', () => {
    expect(MONACO.has('suggest-widget')).toBe(true);
    expect(MONACO.has('right')).toBe(true);
    expect(MONACO.has('slider')).toBe(true);
  });

  it('no Conduit rule styles an element by a class name Monaco also uses', () => {
    expect(collisions()).toEqual([]);
  });
});
