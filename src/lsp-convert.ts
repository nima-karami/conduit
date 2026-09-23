// LSP result shapes → what the renderer is sent. Host only: the renderer never sees a server URI
// (docs/specs/2026-09-22-language-server-go.md §3.2).
import {
  type DocumentSymbol,
  type Hover,
  type Location,
  type LocationLink,
  type MarkedString,
  type MarkupContent,
  type SymbolInformation,
  SymbolKind,
} from 'vscode-languageserver-protocol';
import type { NavTreeNode } from './breadcrumbs';
import type { LspPosition, LspRange } from './lsp-protocol';
import { fileUriToPath } from './lsp-uri';

const rangeOf = (r: { start: LspPosition; end: LspPosition }): LspRange => ({
  start: { line: r.start.line, character: r.start.character },
  end: { line: r.end.line, character: r.end.character },
});

export function toLocations(
  result: Location | Location[] | LocationLink[] | null | undefined,
): { path: string; range: LspRange }[] {
  if (!result) return [];
  const items: (Location | LocationLink)[] = Array.isArray(result) ? result : [result];
  const seen = new Set<string>();
  const out: { path: string; range: LspRange }[] = [];
  for (const item of items) {
    const [uri, range] =
      'targetUri' in item
        ? [item.targetUri, item.targetSelectionRange ?? item.targetRange]
        : [item.uri, item.range];
    const path = fileUriToPath(uri);
    if (path === null) continue;
    const r = rangeOf(range);
    const key = `${path}|${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, range: r });
  }
  return out;
}

function markedToMarkdown(m: MarkedString | MarkupContent): string {
  if (typeof m === 'string') return m;
  if ('kind' in m) return m.value;
  return `\`\`\`${m.language}\n${m.value}\n\`\`\``;
}

export function toHover(
  h: Hover | null | undefined,
): { markdown: string; range?: LspRange } | null {
  if (!h) return null;
  const parts = Array.isArray(h.contents) ? h.contents : [h.contents];
  const markdown = parts
    .map(markedToMarkdown)
    .filter((s) => s.trim() !== '')
    .join('\n\n');
  if (markdown === '') return null;
  return h.range ? { markdown, range: rangeOf(h.range) } : { markdown };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function offsetIn(text: string, starts: readonly number[], pos: LspPosition): number {
  const line = Math.min(Math.max(pos.line, 0), starts.length - 1);
  const start = starts[line] ?? 0;
  const end = line + 1 < starts.length ? (starts[line + 1] ?? text.length) - 1 : text.length;
  return Math.min(start + Math.max(pos.character, 0), end);
}

/** UTF-16 offset of `pos`, clamped into the text. A CRLF's `\r` counts, as it does in Monaco. */
export function offsetAt(text: string, pos: LspPosition): number {
  return offsetIn(text, lineStarts(text), pos);
}

const KIND_NAMES: ReadonlyMap<number, string> = new Map([
  [SymbolKind.Class, 'class'],
  [SymbolKind.Struct, 'class'],
  [SymbolKind.Method, 'method'],
  [SymbolKind.Constructor, 'method'],
  [SymbolKind.Property, 'property'],
  [SymbolKind.Field, 'property'],
  [SymbolKind.Enum, 'enum'],
  [SymbolKind.Interface, 'interface'],
  [SymbolKind.Function, 'function'],
  [SymbolKind.Variable, 'variable'],
  [SymbolKind.Constant, 'const'],
  [SymbolKind.EnumMember, 'enum member'],
  [SymbolKind.TypeParameter, 'type parameter'],
]);

/** LSP `SymbolKind` → the TS kind strings the breadcrumb icons know; unknown → ''. */
export function symbolKindName(kind: number): string {
  return KIND_NAMES.get(kind) ?? '';
}

export function toNavTree(
  symbols: DocumentSymbol[] | SymbolInformation[] | null | undefined,
  text: string,
  fileName: string,
): NavTreeNode {
  const starts = lineStarts(text);
  const span = (r: LspRange) => {
    const start = offsetIn(text, starts, r.start);
    return { start, length: Math.max(0, offsetIn(text, starts, r.end) - start) };
  };
  const fromDocumentSymbol = (s: DocumentSymbol): NavTreeNode => {
    const node: NavTreeNode = {
      text: s.name,
      kind: symbolKindName(s.kind),
      spans: [span(s.range)],
    };
    if (s.children && s.children.length > 0) node.childItems = s.children.map(fromDocumentSymbol);
    return node;
  };
  const list = symbols ?? [];
  const childItems = list.map((s) =>
    'location' in s
      ? { text: s.name, kind: symbolKindName(s.kind), spans: [span(s.location.range)] }
      : fromDocumentSymbol(s),
  );
  return { text: fileName, kind: 'module', spans: [{ start: 0, length: text.length }], childItems };
}
