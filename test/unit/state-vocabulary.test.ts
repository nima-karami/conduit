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

/** Split at `sep` outside (), [] and quotes — `:where(a, b)` is one selector, not two. */
function splitTop(text: string, sep: RegExp | string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (typeof sep === 'string' ? c === sep : sep.test(c))) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The end of a JSX opening tag: the first `>` outside `{…}`, so `=>` in a handler isn't it. */
function tagEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return src.length;
}

/** A JSX tag's own attributes: every `{…}` value but className's is blanked, so an element
    passed as a prop (`action={<button className=…>}`) isn't read as this tag's. */
function ownAttributes(tag: string): string {
  let out = '';
  let depth = 0;
  let keep = false;
  for (let i = 0; i < tag.length; i++) {
    const c = tag[i];
    if (c === '{' && depth++ === 0) keep = /className=$/.test(tag.slice(0, i));
    if (depth === 0 || keep) out += c;
    if (c === '}' && --depth === 0 && !keep) out += '{}';
  }
  return out;
}

const FOCUSABLE_TAG = /^(button|a|input|select|textarea|summary)$/;
/** The ring rule's own list — outside it the ring never paints, so there is nothing to erase. */
const FOCUSABLE_ATTR = /\brole="(button|tab|option|menuitem)"|\btabIndex=(?!\{-1\})/;

/** Every class name the markup writes onto something the ring rule covers. */
const FOCUSABLE_CLASSES = (() => {
  const out = new Set<string>();
  for (const m of MARKUP.matchAll(/<([a-z][\w.]*)\b/gi)) {
    const start = (m.index ?? 0) + m[0].length;
    const tag = MARKUP.slice(start, tagEnd(MARKUP, start));
    if (!FOCUSABLE_TAG.test(m[1]) && !FOCUSABLE_ATTR.test(tag)) continue;
    const cls = /\bclassName=(?:"([^"]*)"|\{([\s\S]*)\})/.exec(tag);
    for (const t of (cls?.[1] ?? cls?.[2] ?? '').matchAll(/[a-z][\w-]*/gi)) out.add(t[0]);
  }
  return out;
})();

/** Whether a selector's subject — its last compound — is a focusable control. */
function focusableSubject(selector: string): boolean {
  const subject = splitTop(selector, /[\s>+~]/).at(-1) ?? '';
  if (FOCUSABLE_TAG.test(/^[a-z]+/i.exec(subject)?.[0] ?? '')) return true;
  if (/\[(role|tabindex)\b/.test(subject)) return true;
  return [...subject.matchAll(/\.([\w-]+)/g)].some(
    ([, cls]) => FOCUSABLE_CLASSES.has(cls) || FOCUSABLE_CLASSES.has(cls.split('--')[0]),
  );
}

/** Every fill a hover rule is allowed to paint, beyond the state tokens themselves. */
const HOVER_FILL_ALLOW = new Map<string, string>([
  ['.winctl__btn--close:hover', 'OS convention: the close button goes red, not grey'],
  ['.ctxmenu__item--danger:hover:not(:disabled)', 'destructive menu item — red is the meaning'],
  ['.btn--danger:hover', 'destructive button — red is the meaning'],
  ['.btn--warn:hover:not(:disabled)', 'warn action — amber is the meaning'],
  ['.attnchip:hover', 'amber is session STATUS (needs you), not interaction state'],
  ['.session--attention:hover', 'amber is session status'],
  ['.session--review:hover', 'amber is session status'],
  ['.session__btn--primary:hover', 'the amber act-on-it button of an attention card'],
  ['.session__kill:hover, .session__kill:focus-visible', 'destructive close — red is the meaning'],
  ['.bcard--proposed, .bcard--proposed:hover', 'amber marks an agent-proposed card'],
  ['.gh__resizer:hover, .gh__resizer:focus-visible', 'drag affordance, not a control'],
  ['.panel__resize:hover::after, body.resizing .panel__resize::after', 'drag affordance'],
  ['.gh__resizer:hover::after, .gh__resizer:focus-visible::after', 'drag affordance'],
  ['*:hover::-webkit-scrollbar-thumb', 'scrollbar thumb, not an app surface'],
  ['::-webkit-scrollbar-thumb:hover', 'scrollbar thumb, not an app surface'],
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

  it('dims a disabled .btn only through the shared rule', () => {
    const own = RULES.filter(
      (r) => /(^|[\s,(])\.btn:disabled/.test(r.selector) && /opacity/.test(r.body),
    ).map((r) => `styles.css:${r.line}`);
    expect(own).toEqual([]);
  });

  it('never repaints the edge of a fill that carries meaning on hover', () => {
    const edge = RULES.find(
      (r) => /--state-edge-hover/.test(r.body) && r.selector.includes('.btn--danger,'),
    );
    for (const role of ['.btn--primary', '.btn--danger', '.btn--warn']) {
      expect(edge?.selector, role).toContain(`${role},`);
    }
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
    // own no rule outside the vocabulary (.branch-chip), and a
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

  it('gives a focusable control its resting shadow only through --rest-shadow', () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      if (rule.selector.startsWith(':where(')) continue;
      const shadow = decls(rule).find(([prop]) => prop === 'box-shadow');
      if (!shadow) continue;
      for (const item of splitTop(rule.selector, ',')) {
        if (item.includes(':focus') || item.includes('::')) continue;
        if (!focusableSubject(item)) continue;
        offenders.push(`styles.css:${rule.line}  ${item} { box-shadow: ${shadow[1]} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('paints --rest-shadow on every control the ring covers, and composes it into the ring', () => {
    const items = (selector = '') =>
      splitTop(selector.replace(/^:where\(|\)(:focus-visible)?$/g, ''), ',');
    const ring = RULES.find(
      (r) => r.selector.startsWith(':where(') && r.selector.endsWith(':focus-visible'),
    );
    const rest = RULES.find(
      (r) => r.selector.startsWith(':where(') && r.body.includes('var(--rest-shadow, none)'),
    );
    expect(ring?.body).toMatch(/box-shadow:\s*var\(--focus-ring\),\s*var\(--rest-shadow,/);
    const restItems = items(rest?.selector);
    const uncovered = items(ring?.selector).filter(
      (e) => !restItems.includes(e) && !restItems.includes(`${/^\[[\w-]+/.exec(e)?.[0]}]`),
    );
    expect(restItems.length).toBeGreaterThan(0);
    expect(uncovered).toEqual([]);
  });

  // One `none` in a shadow list invalidates the whole declaration, so a token composed into the
  // ring (`var(--focus-ring), var(--rest-shadow)`) that resolves to `none` in any theme erases
  // the ring there. A shadow token's "nothing" is a no-op shadow, never `none`.
  it('never declares a shadow token as none', () => {
    const reads = (value: string) => [...value.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    const all = RULES.flatMap(decls);
    const pending = all
      .filter(([prop]) => prop === 'box-shadow' || prop === '--rest-shadow')
      .flatMap(([, value]) => reads(value));
    const shadowTokens = new Set<string>();
    while (pending.length) {
      const token = pending.pop() as string;
      if (shadowTokens.has(token)) continue;
      shadowTokens.add(token);
      for (const [prop, value] of all) if (prop === token) pending.push(...reads(value));
    }
    const offenders = RULES.flatMap((r) =>
      decls(r)
        .filter(([prop, value]) => shadowTokens.has(prop) && value === 'none')
        .map(([prop]) => `styles.css:${r.line}  ${r.selector} { ${prop}: none }`),
    );
    expect(shadowTokens.has('--rest-shadow')).toBe(true);
    expect(offenders).toEqual([]);
  });

  // The reverse of the rule above: --rest-shadow only paints where the rest rule's list reaches,
  // so a surface that sets it but renders on a bare <div> silently loses its shadow.
  it('sets --rest-shadow only on classes whose every element the rest rule reaches', () => {
    const rest = RULES.find(
      (r) => r.selector.startsWith(':where(') && r.body.includes('var(--rest-shadow, none)'),
    );
    expect(rest?.selector).toMatch(/\[role\], \[tabindex\]\)$/);
    const offenders: string[] = [];
    for (const rule of RULES) {
      if (!decls(rule).some(([prop]) => prop === '--rest-shadow')) continue;
      for (const item of splitTop(rule.selector, ',')) {
        const subject = splitTop(item, /[\s>+~]/).at(-1) ?? '';
        if (FOCUSABLE_TAG.test(/^[a-z]+/i.exec(subject)?.[0] ?? '')) continue;
        const classes = [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
        const attrs = [...subject.matchAll(/\[([\w-]+)/g)].map((m) => m[1]);
        if (!classes.length) continue;
        for (const m of MARKUP.matchAll(/<([a-z][\w.]*)\b/gi)) {
          const start = (m.index ?? 0) + m[0].length;
          const tag = ownAttributes(MARKUP.slice(start, tagEnd(MARKUP, start)));
          const cls = /\bclassName=(?:"([^"]*)"|\{([\s\S]*)\})/.exec(tag);
          const tokens = new Set(
            [...(cls?.[1] ?? cls?.[2] ?? '').matchAll(/[a-z][\w-]*/gi)].map((t) => t[0]),
          );
          if (!classes.every((c) => tokens.has(c))) continue;
          if (!attrs.every((a) => tag.includes(a))) continue;
          if (FOCUSABLE_TAG.test(m[1]) || /\brole=|\btabIndex=/.test(tag)) continue;
          offenders.push(`styles.css:${rule.line}  ${item} on <${m[1]} className="${cls?.[1]}">`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Neon's ring sits inside the control, so on a solid fill an accent ring vanishes into it.
  it('gives every filled control the on-fill ring', () => {
    const FILL = /^var\(--(accent|amber)\)$/;
    const offenders: string[] = [];
    for (const rule of RULES) {
      const d = decls(rule);
      const filled = d.some(
        ([p, v]) =>
          ((p === 'background' || p === 'background-color') && FILL.test(v)) ||
          (p === 'color' && v === 'var(--on-accent)'),
      );
      if (!filled) continue;
      if (d.some(([p, v]) => p === '--focus-ring' && v === 'var(--focus-ring-on-fill)')) continue;
      for (const item of splitTop(rule.selector, ',')) {
        if (/:hover|:focus|:active|::/.test(item)) continue;
        if (!focusableSubject(item)) continue;
        offenders.push(`styles.css:${rule.line}  ${item}`);
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
