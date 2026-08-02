import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Enforcement for docs/specs/2026-08-01-interaction-state-vocabulary.md.
 *
 * The sheet reached 27 distinct hover fills and 8 disabled treatments because nothing
 * stopped the next component from inventing its own. These assertions are that stop —
 * the spec's own "without the test they rot back within a release".
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
/** Blank out comments so a value quoted in prose can't be read as a declaration. Length is
    preserved, so an offset found in CSS still points at the same place in SRC. */
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** The section markers live in comments, so they are only findable in the raw text. */
const SECTION_START = CSS.indexOf('═ interaction state vocabulary');
const SECTION_END = CSS.indexOf('end interaction state vocabulary');

const WEBVIEW = join(__dirname, '..', '..', 'webview');
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.tsx') || e.name.endsWith('.ts')
        ? [readFileSync(join(dir, e.name), 'utf8')]
        : [],
  );
}
const MARKUP = sources(WEBVIEW).join('\n');

type Rule = { selector: string; body: string; line: number; at: number };

/** Flat walk of every declaration block, at-rule bodies included, nested blocks excluded. */
function rules(): Rule[] {
  const out: Rule[] = [];
  const open: { selector: string; start: number; at: boolean }[] = [];
  let segment = 0;
  for (let i = 0; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '{') {
      const selector = SRC.slice(segment, i).trim();
      open.push({ selector, start: i + 1, at: selector.startsWith('@') });
      segment = i + 1;
    } else if (c === '}') {
      const frame = open.pop();
      if (frame && !frame.at) {
        out.push({
          selector: frame.selector.replace(/\s+/g, ' '),
          body: SRC.slice(frame.start, i).replace(/\{[^{}]*\}/g, ''),
          line: SRC.slice(0, frame.start).split('\n').length,
          at: frame.start,
        });
      }
      segment = i + 1;
    } else if (c === ';' && open.length === 0) {
      segment = i + 1;
    }
  }
  return out;
}

const RULES = rules();

function decls(rule: Rule): [string, string][] {
  return rule.body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .flatMap((d) => {
      const at = d.indexOf(':');
      return at < 0 ? [] : [[d.slice(0, at).trim(), d.slice(at + 1).trim()] as [string, string]];
    });
}

/** Every fill a hover rule is allowed to paint, beyond the state tokens themselves. */
const HOVER_FILL_ALLOW = new Map<string, string>([
  ['.winctl__btn--close:hover', 'OS convention: the close button goes red, not grey'],
  ['.ctxmenu__item--danger:hover:not(:disabled)', 'destructive menu item — red is the meaning'],
  ['.btn--danger:hover', 'destructive button — red is the meaning'],
  ['.attnchip:hover', 'amber is session STATUS (needs you), not interaction state'],
  ['.session--attention:hover', 'amber is session status'],
  ['.session--review:hover', 'amber is session status'],
  ['.session__btn--primary:hover', 'the amber act-on-it button of an attention card'],
  ['.bcard--proposed, .bcard--proposed:hover', 'amber marks an agent-proposed card'],
  ['.gh__resizer:hover, .gh__resizer:focus-visible', 'drag affordance, not a control'],
  ['.panel__resize:hover::after, body.resizing .panel__resize::after', 'drag affordance'],
  ['.resizer:hover::after, body.resizing .resizer::after', 'drag affordance'],
  ['.gh__resizer:hover::after, .gh__resizer:focus-visible::after', 'drag affordance'],
  ['*:hover::-webkit-scrollbar-thumb', 'scrollbar thumb, not an app surface'],
  ['::-webkit-scrollbar-thumb:hover', 'scrollbar thumb, not an app surface'],
  ['.tabbar:hover::-webkit-scrollbar-thumb', 'scrollbar thumb, not an app surface'],
  ['.tabbar::-webkit-scrollbar-thumb:hover', 'scrollbar thumb, not an app surface'],
  ['.archedge__label:hover', 'canvas edge label — reads against the canvas, not a panel'],
  ['.ifaces__createq, .ifaces__createq:hover', 'a link, not a surface: it has no fill to change'],
]);

/** The vocabulary's own tokens, plus the two solid-role fills the spec names. */
const HOVER_FILL_TOKENS = [
  'var(--state-hover-bg)',
  'var(--state-press-bg)',
  'var(--state-sel-bg)',
  'var(--state-sel-hover-bg)',
  'var(--accent-2)',
];

describe('interaction state vocabulary', () => {
  it('paints hover only from the state tokens', () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      if (!rule.selector.includes(':hover')) continue;
      for (const [prop, value] of decls(rule)) {
        if (prop !== 'background' && prop !== 'background-color') continue;
        if (HOVER_FILL_TOKENS.includes(value)) continue;
        if (HOVER_FILL_ALLOW.has(rule.selector)) continue;
        offenders.push(`styles.css:${rule.line}  ${rule.selector} { ${prop}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has exactly one disabled opacity', () => {
    const values = new Map<string, string[]>();
    for (const rule of RULES) {
      if (!/:disabled|\[disabled\]|\[aria-disabled="true"\]/.test(rule.selector)) continue;
      for (const [prop, value] of decls(rule)) {
        if (prop !== 'opacity') continue;
        values.set(value, [...(values.get(value) ?? []), `styles.css:${rule.line}`]);
      }
    }
    expect([...values.keys()]).toEqual(['var(--state-disabled-o)']);
  });

  it('defines every --state-* token it references', () => {
    const defined = new Set([...SRC.matchAll(/^\s*(--state-[\w-]+)\s*:/gm)].map((m) => m[1]));
    const used = new Set([...SRC.matchAll(/var\((--state-[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
    // The reverse rot: a token nobody reads is a token nobody maintains.
    expect([...defined].filter((t) => !used.has(t))).toEqual([]);
  });

  it('names only surfaces that still exist', () => {
    expect(SECTION_START).toBeGreaterThan(-1);
    const section = SRC.slice(SECTION_START, SECTION_END);
    const named = new Set(
      [...section.matchAll(/^\s+(\.[\w-]+)(?:\[[^\]]*\])?,?$/gm)].map((m) => m[1]),
    );
    expect(named.size).toBeGreaterThan(50);
    // Live means one of two things, because neither alone covers the sheet: a surface may
    // own no rule outside the vocabulary (.git-indicator__branch--switchable), and a
    // modifier may be assembled at runtime rather than written out (`session--${state}`).
    const outside = RULES.filter((r) => r.at < SECTION_START || r.at > SECTION_END);
    const missing = [...named].filter((cls) => {
      const base = new RegExp(`(^|[,\\s])\\${cls}(?![\\w-])`, 'm');
      return !MARKUP.includes(cls.slice(1)) && !outside.some((r) => base.test(r.selector));
    });
    expect(missing).toEqual([]);
  });

  it('routes every focus ring through --focus-ring', () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      if (!rule.selector.includes(':focus')) continue;
      for (const [prop, value] of decls(rule)) {
        if (prop === 'outline' && /\bsolid\b/.test(value)) {
          offenders.push(`styles.css:${rule.line}  ${rule.selector} { outline: ${value} }`);
        }
        if (prop === 'box-shadow' && !value.includes('--focus-ring') && value !== 'none') {
          offenders.push(`styles.css:${rule.line}  ${rule.selector} { box-shadow: ${value} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // A zero-specificity role list is worth exactly one class — the same as the
  // `background: transparent` a component states at rest — so the ladder only lands if it
  // comes after them. Hence the section is at the foot of the sheet. Move it up and every
  // hover on a surface with an explicit resting fill quietly stops painting: nothing in the
  // CSS looks wrong, and the loss only shows up in a screenshot.
  it('keeps the role lists at the foot of the sheet', () => {
    const early = RULES.filter((r) => r.at < SECTION_START && /^:where\(\s*\./.test(r.selector));
    expect(early.map((r) => `styles.css:${r.line}  ${r.selector.slice(0, 50)}`)).toEqual([]);
    expect(SRC.slice(SECTION_END).trim()).toBe('');
  });
});
