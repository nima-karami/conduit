import { parse, stringify } from 'smol-toml';
import { deepEqualConfig } from './install-entries';
import { type CodexEntry, ConfigFormatError } from './install-types';

const CONDUIT_KEYS = ['mcp_servers', 'conduit'] as const;

export function tomlBasicString(v: string): string {
  let out = '"';
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (code <= 0x1f || code === 0x7f) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlBasicString(k);
}

function tomlStringArray(items: readonly string[]): string {
  return `[${items.map(tomlBasicString).join(', ')}]`;
}

export function renderCodexTable(e: CodexEntry, eol: '\n' | '\r\n'): string {
  const env = Object.entries(e.env)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlBasicString(v)}`)
    .join(', ');
  return [
    '[mcp_servers.conduit]',
    `command = ${tomlBasicString(e.command)}`,
    `args = ${tomlStringArray(e.args)}`,
    `env = { ${env} }`,
    `env_vars = ${tomlStringArray(e.env_vars)}`,
    `default_tools_approval_mode = ${tomlBasicString(e.default_tools_approval_mode)}`,
    '',
  ].join(eol);
}

type TomlDoc = Record<string, unknown>;

function isTable(v: unknown): v is TomlDoc {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function parseToml(text: string): TomlDoc {
  try {
    return parse(text);
  } catch (e) {
    throw new ConfigFormatError('ETOML', e instanceof Error ? e.message : String(e));
  }
}

function conduitOf(doc: TomlDoc): unknown {
  const servers = doc.mcp_servers;
  return isTable(servers) ? servers.conduit : undefined;
}

export function readCodexConduit(text: string): unknown {
  return conduitOf(parseToml(text));
}

/** Lines with their terminators, so joining a slice reproduces the original bytes exactly. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface Header {
  keys: string[];
  array: boolean;
}

/** A table header line, or null for anything else (including text that only looks like one). */
function parseHeader(rawLine: string): Header | null {
  const line = rawLine.replace(/\r?\n$/, '');
  let i = line.search(/\S/);
  if (i === -1 || line[i] !== '[') return null;
  const array = line[i + 1] === '[';
  i += array ? 2 : 1;
  const keys: string[] = [];
  const ws = () => {
    while (line[i] === ' ' || line[i] === '\t') i++;
  };
  for (;;) {
    ws();
    const ch = line[i];
    if (ch === '"') {
      const m = /^"(?:[^"\\]|\\.)*"/.exec(line.slice(i));
      if (!m) return null;
      try {
        keys.push(JSON.parse(m[0]));
      } catch {
        return null;
      }
      i += m[0].length;
    } else if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) return null;
      keys.push(line.slice(i + 1, close));
      i = close + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (!m) return null;
      keys.push(m[0]);
      i += m[0].length;
    }
    ws();
    if (line[i] === '.') {
      i++;
      continue;
    }
    const close = array ? ']]' : ']';
    if (!line.startsWith(close, i)) return null;
    i += close.length;
    return /^\s*(#.*)?$/.test(line.slice(i)) ? { keys, array } : null;
  }
}

function underConduit(h: Header): boolean {
  return CONDUIT_KEYS.every((k, i) => h.keys[i] === k);
}

function isConduitHeader(h: Header): boolean {
  return !h.array && h.keys.length === CONDUIT_KEYS.length && underConduit(h);
}

export type ConduitTableLocation =
  | { kind: 'absent' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'uneditable' };

interface Located {
  doc: TomlDoc;
  lines: string[];
  loc: ConduitTableLocation;
}

// Spec 2026-10-27-conduit-mcp-install §3.5 step 2: only a [mcp_servers.conduit] table plus its
// contiguous subtables is a range we can swap without touching anyone else's bytes.
function locate(text: string): Located {
  const doc = parseToml(text);
  const lines = splitLines(text);
  const headers = lines.flatMap((l, line) => {
    const h = parseHeader(l);
    return h ? [{ ...h, line }] : [];
  });
  const ours = headers.filter(underConduit);
  const defined = conduitOf(doc) !== undefined;
  if (!defined && ours.length === 0) return { doc, lines, loc: { kind: 'absent' } };
  const first = ours[0];
  if (first === undefined || !isConduitHeader(first) || ours.some((h) => h.array)) {
    return { doc, lines, loc: { kind: 'uneditable' } };
  }
  const at = headers.indexOf(first);
  let next = at + 1;
  for (let h = headers[next]; h !== undefined && underConduit(h); h = headers[next]) next++;
  if (ours.length !== next - at) return { doc, lines, loc: { kind: 'uneditable' } };
  let end = headers[next]?.line ?? lines.length;
  // Comments before the next header are that table's, or the user's: our table never holds one, so
  // leaving them outside the range loses nothing of ours and deletes nothing of theirs.
  const trailing = (l: string) => l.trim() === '' || l.trimStart().startsWith('#');
  while (end > first.line + 1 && trailing(lines[end - 1] ?? '')) end--;
  // TOML forbids also defining a headed table by dotted keys or inline, so a valid file cannot mix
  // forms here; the splice guard still catches any parser leniency.
  return { doc, lines, loc: { kind: 'range', start: first.line, end } };
}

export function locateConduitTable(text: string): ConduitTableLocation {
  return locate(text).loc;
}

function withConduit(doc: TomlDoc, entry: TomlDoc | CodexEntry | null, after: TomlDoc): TomlDoc {
  const servers = isTable(doc.mcp_servers) ? { ...doc.mcp_servers } : {};
  if (entry === null) delete servers.conduit;
  else servers.conduit = entry;
  const out: TomlDoc = { ...doc, mcp_servers: servers };
  // A parent table created only implicitly by our header disappears with it; that is not a change.
  if (Object.keys(servers).length === 0 && !Object.hasOwn(after, 'mcp_servers')) {
    delete out.mcp_servers;
  }
  return out;
}

export function spliceConduitTable(text: string, entry: CodexEntry | null): string {
  return splice(text, entry, (eol) => (entry === null ? '' : renderCodexTable(entry, eol)));
}

/**
 * Repair's table: the user's entry with only its paths changed, so any key renderCodexTable doesn't
 * know (`enabled`, `startup_timeout_sec`, a tools subtable) is kept (spec §14 D2).
 */
export function spliceRepairedTable(text: string, entry: Readonly<TomlDoc>): string {
  return splice(text, entry, (eol) =>
    stringify({ mcp_servers: { conduit: entry } }).replaceAll('\n', eol),
  );
}

type Eol = '\n' | '\r\n';

function splice(
  text: string,
  entry: TomlDoc | CodexEntry | null,
  render: (eol: Eol) => string,
): string {
  const { doc, lines, loc } = locate(text);
  if (loc.kind === 'uneditable') {
    throw new ConfigFormatError('EUNEDITABLE', 'conduit is defined in a form Conduit cannot edit');
  }
  const eol = /^[^\n]*\r\n/.test(text) ? '\r\n' : '\n';
  let out: string;
  if (loc.kind === 'absent') {
    if (entry === null) return text;
    let prefix = text;
    if (prefix !== '' && !prefix.endsWith('\n')) prefix += eol;
    const last = lines[lines.length - 1];
    if (prefix !== '' && last !== undefined && last.trim() !== '') prefix += eol;
    out = prefix + render(eol);
  } else {
    const table = render(eol);
    out = [...lines.slice(0, loc.start), table, ...lines.slice(loc.end)].join('');
  }
  let after: TomlDoc;
  try {
    after = parse(out);
  } catch (e) {
    throw new ConfigFormatError('EGUARD', e instanceof Error ? e.message : String(e));
  }
  if (!deepEqualConfig(after, withConduit(doc, entry, after))) {
    throw new ConfigFormatError('EGUARD', 'the edit would change more than mcp_servers.conduit');
  }
  return out;
}
