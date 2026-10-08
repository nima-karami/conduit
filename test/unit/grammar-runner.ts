/**
 * Runs a Monarch grammar the way Monarch runs it, over a subset of rule shapes: the first rule
 * whose regex matches anchored at the cursor wins; a rule written with a leading `^` only matches
 * at column 0 (monarchCompile's `matchOnlyAtLineStart`); an array action tokens the regex's groups
 * in order; the state stack carries across lines. Monaco can't load in the node env, so this
 * interpreter is what the grammar units run on — the real tokenizer is covered by the e2e suites.
 * Any rule shape outside the subset throws, so a grammar can't drift into something this runner
 * silently mis-reads.
 */

import type { Grammar } from '../../webview/gomod-grammar';

export type GrammarToken = [text: string, token: string];

type Next = string | undefined;
interface Compiled {
  re: RegExp;
  atStart: boolean;
  tokens: string[] | string;
  next: Next;
}
type Entry = Compiled | { include: string };

const unsupported = (rule: unknown): never => {
  throw new Error(
    `unsupported rule ${JSON.stringify(rule, (_k, v) => (v instanceof RegExp ? String(v) : v))}`,
  );
};

function compileRule(rule: unknown, flags: string): Entry {
  if (!Array.isArray(rule)) {
    const inc = (rule as { include?: unknown }).include;
    if (typeof inc === 'string' && inc.startsWith('@')) return { include: inc.slice(1) };
    return unsupported(rule);
  }
  const [re, action, next] = rule as [unknown, unknown, unknown];
  if (!(re instanceof RegExp)) return unsupported(rule);
  // Monarch substitutes `@name` inside a regex with a language attribute and throws when the
  // attribute is missing, so a literal `@` followed by a word character is a latent crash.
  if (/@\w/.test(re.source)) return unsupported(rule);
  const atStart = re.source.startsWith('^');
  const body = atStart ? re.source.slice(1) : re.source;
  const compiled = new RegExp(`^(?:${body})`, flags);
  if (typeof action === 'string' && (next === undefined || typeof next === 'string')) {
    if (action.startsWith('@')) return unsupported(rule);
    return { re: compiled, atStart, tokens: action, next: next as Next };
  }
  if (Array.isArray(action) && next === undefined && action.every((t) => typeof t === 'string')) {
    return { re: compiled, atStart, tokens: action as string[], next: undefined };
  }
  if (action && typeof action === 'object' && !Array.isArray(action) && next === undefined) {
    const { token, next: n, ...rest } = action as { token?: unknown; next?: unknown };
    if (typeof token !== 'string' || Object.keys(rest).length > 0) return unsupported(rule);
    if (n !== undefined && typeof n !== 'string') return unsupported(rule);
    return { re: compiled, atStart, tokens: token, next: n as Next };
  }
  return unsupported(rule);
}

function compile(grammar: Grammar): Map<string, Compiled[]> {
  const lang = grammar.language as unknown as {
    ignoreCase?: boolean;
    tokenizer: Record<string, unknown[]>;
  };
  const flags = lang.ignoreCase ? 'i' : '';
  const raw = new Map<string, Entry[]>();
  for (const [state, rules] of Object.entries(lang.tokenizer)) {
    raw.set(
      state,
      rules.map((r) => compileRule(r, flags)),
    );
  }
  const flat = new Map<string, Compiled[]>();
  const expand = (state: string, seen: Set<string>): Compiled[] => {
    const entries = raw.get(state);
    if (!entries) throw new Error(`unknown state @${state}`);
    if (seen.has(state)) throw new Error(`include cycle at @${state}`);
    return entries.flatMap((e) =>
      'include' in e ? expand(e.include, new Set([...seen, state])) : [e],
    );
  };
  for (const state of raw.keys()) flat.set(state, expand(state, new Set()));
  return flat;
}

function applyNext(stack: string[], next: Next, states: Map<string, Compiled[]>): void {
  if (next === undefined) return;
  if (next === '@pop') {
    if (stack.length === 1) throw new Error('@pop on an empty stack');
    stack.pop();
  } else if (next === '@push') {
    stack.push(stack[stack.length - 1]);
  } else if (next.startsWith('@') && states.has(next.slice(1))) {
    stack.push(next.slice(1));
  } else {
    throw new Error(`unsupported next ${next}`);
  }
}

/**
 * Tokens per line, adjacent equal tokens merged (Monarch emits one span for them), with plain
 * (`''`) and `white` text dropped so a test names only what is coloured.
 */
export function tokenizeLines(grammar: Grammar, lines: readonly string[]): GrammarToken[][] {
  const states = compile(grammar);
  const stack = ['root'];
  return lines.map((line) => {
    const raw: GrammarToken[] = [];
    let pos = 0;
    // Monarch evaluates the rules once even on an empty line, so a rule can pop there.
    let force = true;
    while (force || pos < line.length) {
      force = false;
      const rest = line.slice(pos);
      let hit: GrammarToken[] | null = null;
      let next: Next;
      for (const r of states.get(stack[stack.length - 1]) ?? []) {
        if (r.atStart && pos > 0) continue;
        const m = r.re.exec(rest);
        if (!m) continue;
        // Monarch takes the first match even when it is empty, and throws unless it moves state.
        if (m[0] === '' && r.next === undefined && line.length > 0) {
          throw new Error(`no progress at ${pos} in ${JSON.stringify(line)} (${r.re})`);
        }
        if (typeof r.tokens === 'string') hit = [[m[0], r.tokens]];
        else {
          const groups = m.slice(1);
          if (groups.length !== r.tokens.length || groups.join('') !== m[0]) {
            throw new Error(`groups don't cover ${JSON.stringify(m[0])}`);
          }
          hit = groups.map((g, i) => [g ?? '', (r.tokens as string[])[i]] as GrammarToken);
        }
        next = r.next;
        break;
      }
      if (!hit) {
        if (pos >= line.length) break;
        // Monarch's fallback: one character as the default token.
        hit = [[line[pos], '']];
      }
      for (const t of hit) {
        pos += t[0].length;
        const last = raw[raw.length - 1];
        if (last && last[1] === t[1]) last[0] += t[0];
        else if (t[0] !== '') raw.push([t[0], t[1]]);
      }
      applyNext(stack, next, states);
    }
    return raw.filter(([, token]) => token !== '' && token !== 'white');
  });
}

/** Each tokenizer state's RegExps in rule order, whatever the action shape. */
export function grammarRegExps(grammar: Grammar): RegExp[][] {
  const lang = grammar.language as unknown as { tokenizer: Record<string, unknown[]> };
  return Object.values(lang.tokenizer).map((rules) =>
    rules.flatMap((r) => (Array.isArray(r) && r[0] instanceof RegExp ? [r[0]] : [])),
  );
}

/** Every token name a grammar's rules can emit. */
export function grammarTokens(grammar: Grammar): Set<string> {
  const lang = grammar.language as unknown as { tokenizer: Record<string, unknown[]> };
  const out = new Set<string>();
  for (const rules of Object.values(lang.tokenizer)) {
    for (const r of rules) {
      if (!Array.isArray(r)) continue;
      const action = r[1] as unknown;
      if (typeof action === 'string') out.add(action);
      else if (Array.isArray(action)) for (const t of action) out.add(String(t));
      else if (action && typeof action === 'object')
        out.add(String((action as { token: unknown }).token));
    }
  }
  return out;
}
