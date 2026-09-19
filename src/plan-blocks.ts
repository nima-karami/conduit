import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { contentHash } from './review-marks';

export type PlanBlockKind = 'prose' | 'code' | 'diagram';

export interface PlanBlock {
  index: number;
  kind: PlanBlockKind;
  lang: string | null;
  start: number;
  end: number;
  source: string;
  hash: string;
  snippet: string;
}

export interface PlanSplit {
  frontmatter: string;
  body: string;
  blocks: PlanBlock[];
}

export const SNIPPET_CHARS = 60;

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);

export function normalizeBlockSource(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

function snippetOf(source: string): string {
  const line = source.split('\n').find((l) => l.trim().length > 0);
  return (line?.trim() ?? '').slice(0, SNIPPET_CHARS);
}

export function splitPlan(markdown: string): PlanSplit {
  const children = processor.parse(markdown).children;

  let base = 0;
  const first = children[0];
  if (first?.type === 'yaml') {
    const yamlEnd = first.position?.end.offset ?? 0;
    base = yamlEnd + (/^[\r\n]*/.exec(markdown.slice(yamlEnd))?.[0].length ?? 0);
  }

  const blocks: PlanBlock[] = [];
  for (const node of children) {
    if (node.type === 'yaml') continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // remark always records offsets; the guard is for the optional mdast type, not a real case.
    if (start === undefined || end === undefined) continue;
    const source = markdown.slice(start, end);
    const lang = node.type === 'code' ? (node.lang ?? null) : null;
    const kind: PlanBlockKind =
      node.type !== 'code' ? 'prose' : lang === 'mermaid' ? 'diagram' : 'code';
    blocks.push({
      index: blocks.length,
      kind,
      lang,
      start: start - base,
      end: end - base,
      source,
      hash: contentHash(normalizeBlockSource(source)),
      snippet: snippetOf(source),
    });
  }

  return { frontmatter: markdown.slice(0, base), body: markdown.slice(base), blocks };
}

export function composePlan(frontmatter: string, body: string): string {
  return `${frontmatter}${body.replace(/\n+$/, '')}\n`;
}
