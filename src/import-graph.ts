/**
 * Resolve the import closure of the file the user just opened, so the language worker gets
 * the files a go-to-definition is actually about to need BEFORE the rest of the project
 * streams in. Pure (reads are injected) — this is the ordering that decides whether the
 * first F12 of a session feels instant.
 *
 * Deliberately a scanner, not a parser: it only has to be right about which files to load
 * FIRST. A missed specifier costs a little latency (the file arrives in a later chunk); a
 * false positive costs nothing (the path isn't in the candidate set).
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §2b.
 */

/** How many files the priority wave may pull in before the rest streams normally. */
const PRIORITY_WAVE_CAP = 300;

// The `import(`/`require(` alternatives come first: `\bimport\s*` would otherwise match the
// keyword and then fail on the paren, skipping dynamic imports entirely.
const SPECIFIER_RE =
  /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s*|\bexport\s+\*\s+from\s*)['"]([^'"\n]+)['"]/g;

/** Extract module specifiers from source text. Order-preserving, de-duplicated. */
export function scanImports(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  SPECIFIER_RE.lastIndex = 0;
  let m = SPECIFIER_RE.exec(content);
  while (m) {
    const spec = m[1];
    if (!seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
    m = SPECIFIER_RE.exec(content);
  }
  return out;
}

/** Extension probing order, mirroring TypeScript's own preference. */
const EXT_CANDIDATES = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/**
 * Resolve a RELATIVE specifier against the candidate set, probing extensions and
 * `/index.*` the way TS does. Bare specifiers (packages) return null — dependency types
 * are out of the priority wave by design.
 */
export function resolveRelative(
  fromFile: string,
  spec: string,
  candidates: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(`${dirOf(fromFile)}/${spec}`);
  // An explicit extension that exists wins outright; `./x.js` in ESM-style TS also has to
  // fall through to `./x.ts`, hence the probing below rather than an early return.
  if (candidates.has(base)) return base;
  const withoutJsExt = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  for (const stem of base === withoutJsExt ? [base] : [withoutJsExt, base]) {
    for (const ext of EXT_CANDIDATES) {
      const cand = `${stem}${ext}`;
      if (candidates.has(cand)) return cand;
    }
    for (const ext of EXT_CANDIDATES) {
      const cand = `${stem}/index${ext}`;
      if (candidates.has(cand)) return cand;
    }
  }
  return null;
}

function normalize(p: string): string {
  const s = p.replace(/\\/g, '/');
  const drive = /^[a-zA-Z]:/.exec(s)?.[0] ?? '';
  const rest = s.slice(drive.length);
  const out: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `${drive}/${out.join('/')}`;
}

/**
 * Breadth-first walk of the import graph from `seeds`, bounded by `cap`. `read` returns a
 * file's text or null (unreadable files are simply not expanded). The result is ordered
 * seeds-first, then by distance — which is the order the chunks should be sent in.
 *
 * Async because the host reads through its own file service; the walk awaits one file at a
 * time on purpose, so a huge closure can't fan out into thousands of concurrent reads while
 * the user is waiting for the editor to open.
 */
export async function importClosure(
  seeds: readonly string[],
  candidates: ReadonlySet<string>,
  read: (path: string) => Promise<string | null>,
  cap = PRIORITY_WAVE_CAP,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of seeds) {
    const n = normalize(s);
    if (candidates.has(n) && !seen.has(n)) {
      seen.add(n);
      queue.push(n);
    }
  }
  while (queue.length && out.length < cap) {
    const file = queue.shift();
    if (file === undefined) break;
    out.push(file);
    const content = await read(file);
    if (content === null) continue;
    for (const spec of scanImports(content)) {
      const target = resolveRelative(file, spec, candidates);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return out;
}
