import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An overlay that is invisible but still hit-testable eats the pointer: `elementFromPoint`
 * over the control returns the overlay, so the click never reaches the thing the user can
 * actually see. Two destructive buttons shipped that way — the git change row's `discard` and
 * the session card's `kill` sat at `opacity: 0` with no `pointer-events` gating, live and
 * clickable with nothing drawn there. Monaco's widget tooltip is the same defect from the
 * other side: it is clamped down over the very button it labels ("Close (Escape)") and, being
 * hit-testable, swallows that button's clicks.
 *
 * The occlusion half is out of reach of the smoke suite — Monaco raises that tooltip only when
 * the OS window is genuinely focused, and the e2e runner launches the app hidden on purpose.
 * So these rules are derived from the sheet instead of pinned to today's selectors: a new
 * fade-in overlay that forgets to gate its pointer events has to fail here or nowhere.
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
/** Comments blanked so prose quoting a property can't be read as a declaration. */
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

type Rule = { selectors: string[]; body: string; line: number };

/**
 * Every declaration block in the sheet as selector group + body. The pattern cannot cross a
 * brace, so an at-rule contributes the rules nested inside it and never a block of its own.
 */
const RULES: Rule[] = [...SRC.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({
    selectors: m[1]
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean),
    body: m[2],
    line: SRC.slice(0, m.index + Math.max(0, m[1].search(/\S/))).split('\n').length,
  }))
  .filter((r) => r.selectors.length > 0 && !r.selectors[0].startsWith('@'));

/** Last declared value of `prop` in the block, or null. */
function decl(rule: Rule, prop: string): string | null {
  const found = [...rule.body.matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+)`, 'g'))];
  return found.length ? found[found.length - 1][1].trim() : null;
}

function where(rule: Rule): string {
  return `${rule.selectors.join(', ')} (styles.css:${rule.line})`;
}

const STATE = /:hover|:focus-within|:focus-visible/;

/** Combinators hide inside argument lists (`:has(> .x)`); drop those before splitting. */
function stripArgs(sel: string): string {
  let out = sel;
  while (/\([^()]*\)/.test(out)) out = out.replace(/\([^()]*\)/g, '');
  return out;
}

function compounds(sel: string): string[] {
  return stripArgs(sel)
    .split(/\s*[\s>+~]\s*/)
    .filter(Boolean);
}

/** The element a selector targets, stripped of the state pseudos that qualify it. */
function target(sel: string): string {
  const last = compounds(sel).at(-1) ?? sel;
  return last.replace(/:(focus-visible|focus-within|focus|hover|active)/g, '');
}

function hasAncestorState(sel: string): boolean {
  return compounds(sel)
    .slice(0, -1)
    .some((c) => STATE.test(c));
}

function opacity(rule: Rule): number {
  return Number.parseFloat(decl(rule, 'opacity') ?? '');
}

const FADED = RULES.filter((r) => opacity(r) === 0);
const RAISED = RULES.filter((r) => opacity(r) > 0);

/** Resting selectors only: a faded block that is itself state-keyed is rule 2's business. */
function baseTargets(rule: Rule): string[] {
  return rule.selectors.filter((s) => !STATE.test(s)).map(target);
}

/**
 * Selectors that can plausibly be the path by which a gated element comes back. A state pseudo
 * on the element itself is only half of that: `S:hover` cannot fire while S is
 * `pointer-events: none`, so it is never the reveal — but keyboard focus reaches a gated
 * element fine, so `S:focus-visible` is.
 */
function revealTargets(rule: Rule): string[] {
  const reveals = (s: string) =>
    hasAncestorState(s) || /:focus-(visible|within)/.test(compounds(s).at(-1) ?? '');
  return rule.selectors.filter(reveals).map(target);
}

const REVEALS = RAISED.filter((r) => revealTargets(r).length > 0);

/**
 * A block whose selectors are all self-state refinements (`S:hover`, `S:focus-visible`) can
 * only ever apply on top of an ancestor-keyed reveal — hovering S hovers its ancestors,
 * focusing S puts `:focus-within` on them — so it already inherits that block's
 * `pointer-events` and restating them would be dead CSS. Only true while such a block exists.
 */
function coveredByAncestorReveal(rule: Rule, tgt: string): boolean {
  if (rule.selectors.some(hasAncestorState)) return false;
  return REVEALS.some(
    (other) =>
      other !== rule &&
      decl(other, 'pointer-events') === 'auto' &&
      other.selectors.some((s) => hasAncestorState(s) && target(s) === tgt),
  );
}

describe('faded overlays', () => {
  const pairs: { base: Rule; reveal: Rule; tgt: string }[] = [];
  for (const base of FADED) {
    for (const tgt of baseTargets(base)) {
      for (const reveal of REVEALS) {
        if (reveal === base || !revealTargets(reveal).includes(tgt)) continue;
        pairs.push({ base, reveal, tgt });
      }
    }
  }

  it('are found by the rule at all', () => {
    // Vacuity guard: a rename that stops the pairing from matching would otherwise turn every
    // assertion below green while guarding nothing.
    const covered = new Set(pairs.map((p) => p.tgt));
    for (const proven of ['.change__row-actions', '.session__kill']) {
      const msg = `${proven} is no longer seen as a fade-in overlay`;
      expect([...covered], msg).toContain(proven);
    }
    expect(covered.size).toBeGreaterThanOrEqual(6);
  });

  it('are untouchable at rest', () => {
    const missing = new Set<string>();
    for (const { base } of pairs) {
      if (decl(base, 'pointer-events') !== 'none') {
        missing.add(`${where(base)} — fades to opacity: 0 without pointer-events: none`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('take the pointer back when they fade in', () => {
    const missing = new Set<string>();
    for (const { reveal, tgt } of pairs) {
      if (coveredByAncestorReveal(reveal, tgt)) continue;
      if (decl(reveal, 'pointer-events') !== 'auto') {
        missing.add(`${where(reveal)} — reveals ${tgt} but never declares pointer-events: auto`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe('controls hidden under the pointer', () => {
  it('stop hit-testing while they are invisible', () => {
    const missing = new Set<string>();
    for (const rule of FADED) {
      const hidden = rule.selectors.filter((s) => /:hover|:focus-within/.test(s));
      if (!hidden.length) continue;
      if (decl(rule, 'pointer-events') !== 'none') {
        missing.add(`${where(rule)} — hides on hover but never declares pointer-events: none`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe('monaco hover widgets', () => {
  const gated = new Set<string>();
  for (const rule of RULES) {
    if (decl(rule, 'pointer-events') !== 'none') continue;
    for (const s of rule.selectors) gated.add(s);
  }

  it.each(['.monaco-hover.workbench-hover', '.workbench-hover-container'])(
    '%s cannot swallow the control it labels',
    (sel) => {
      expect([...gated], `${sel} is missing pointer-events: none`).toContain(sel);
    },
  );

  it('gates the context-view wrapper that hosts the tooltip', () => {
    const host = [...gated].filter(
      (s) => s.includes('.context-view') && s.includes('.workbench-hover-container'),
    );
    const msg = 'nothing gates the .context-view wrapper around .workbench-hover-container';
    expect(host.length, msg).toBeGreaterThan(0);
  });

  it('leaves Monaco’s interactive content hovers alone', () => {
    // A bare `.monaco-hover` would also gate the editor's content hovers, which have links and
    // scroll — the tooltip fix has to stay scoped to the widget (`.workbench-hover`) variant.
    const overbroad = [...gated].filter((s) => /(^|[\s>+~])\.monaco-hover(?![-\w.:[])/.test(s));
    const msg = 'these gate Monaco’s interactive content hovers, not just its tooltips';
    expect(overbroad, msg).toEqual([]);
  });
});
