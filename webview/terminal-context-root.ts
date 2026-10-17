/**
 * Which session root the agent was last working in, read off the terminal lines above a path
 * token (spec 2026-10-16-terminal-path-links §3.3 "context root"). A ranking signal only, never an
 * auto-resolve. Pure.
 */
import type { ResolveRoot } from '../src/path-link-roots';
import {
  expandToken,
  isAbsoluteToken,
  joinAbs,
  normalizeAbs,
  type PathPlatform,
} from '../src/path-token-normalize';
import { detectPathTokens } from './terminal-links';

export const CONTEXT_WINDOW_LINES = 200;

export interface ContextRootCtx {
  cwd: string;
  platform: PathPlatform;
  caseSensitive: boolean;
}

// `cd` as a command word: line start or after a shell separator / Claude Code's `Bash(`.
const CD_RE = /(?:^|[\s(&;|])cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|()"']+))/g;
const GIT_C_RE = /(?:^|[\s(&;|])git\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|()"']+))/g;

interface Signal {
  /** A cd moves the base later relative signals resolve against; git -C does not. */
  moves: boolean;
  dir: string;
}

function dirSignals(line: string, re: RegExp, moves: boolean): Signal[] {
  const out: Signal[] = [];
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(line);
    if (m === null) return out;
    const dir = m[1] ?? m[2] ?? m[3];
    // `cd -` and `~` need state this module never sees (OLDPWD, the shell's home).
    if (!dir || dir === '-' || dir.startsWith('~')) continue;
    out.push({ moves, dir });
  }
}

export function inferContextRoot(
  linesAbove: readonly string[],
  roots: readonly ResolveRoot[],
  ctx: ContextRootCtx,
): number | undefined {
  if (roots.length === 0) return undefined;
  const fold = (p: string) => {
    const n = normalizeAbs(p, ctx.platform);
    return ctx.caseSensitive ? n : n.toLowerCase();
  };
  const rootKeys = roots.map((r) => fold(r.abs));
  const deepest = (abs: string): number | undefined => {
    const k = fold(abs);
    let best: number | undefined;
    rootKeys.forEach((rk, i) => {
      const under = k === rk || k.startsWith(rk.endsWith('/') ? rk : `${rk}/`);
      if (under && (best === undefined || rk.length > rootKeys[best].length)) best = i;
    });
    return best;
  };
  const expand = (d: string) => expandToken(d, { platform: ctx.platform, homeDir: '' });

  const window = linesAbove.slice(0, CONTEXT_WINDOW_LINES);
  // Per line, nearest first: its cd / git -C dirs (in line order), then its absolute paths.
  const perLine = window.map((line) => ({
    dirs: [...dirSignals(line, CD_RE, true), ...dirSignals(line, GIT_C_RE, false)],
    paths: detectPathTokens(line, undefined)
      .map((t) => t.raw)
      .filter((p) => isAbsoluteToken(p, ctx.platform)),
  }));

  // A relative dir resolves against the cd before it, which is FARTHER up: resolve oldest first.
  const resolved: string[][] = perLine.map(() => []);
  let base = ctx.cwd;
  for (let i = perLine.length - 1; i >= 0; i--) {
    for (const s of perLine[i].dirs) {
      const abs = joinAbs(base, expand(s.dir), ctx.platform);
      resolved[i].push(abs);
      if (s.moves) base = abs;
    }
  }

  for (let i = 0; i < perLine.length; i++) {
    // The last cd on a line is the one the rest of that command ran in.
    for (const abs of [...resolved[i]].reverse()) {
      const idx = deepest(abs);
      if (idx !== undefined) return idx;
    }
    for (const p of perLine[i].paths) {
      const idx = deepest(normalizeAbs(expand(p), ctx.platform));
      if (idx !== undefined) return idx;
    }
  }
  return undefined;
}
