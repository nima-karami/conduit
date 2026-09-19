import { normalizeBlockSource, type PlanBlock } from './plan-blocks';
import type { AnchoredComment } from './plan-comments';

/**
 * The agent handoff for an interactive plan (spec 2026-09-19-interactive-plan §3). Pure and
 * node-free so the exact bytes that reach a terminal are unit-testable — the delivery is a
 * bracketed paste with NO trailing newline, because that is what would make some TUIs submit and
 * the spec is explicit that the user presses Enter. Mirrors src/review-handoff.ts.
 */

export interface PlanHandoffInput {
  planPath: string;
  changed: readonly PlanBlock[];
  removed: number;
  comments: readonly AnchoredComment[];
  blocks: readonly PlanBlock[];
}

function label(b: PlanBlock): string {
  const n = `§${b.index + 1}`;
  if (b.kind === 'diagram') return `- ${n} diagram:`;
  if (b.kind === 'code') return b.lang ? `- ${n} code (${b.lang}):` : `- ${n} code:`;
  return `- ${n} prose "${b.snippet}":`;
}

function commentLine({ comment, index }: AnchoredComment, blocks: readonly PlanBlock[]): string {
  const text = comment.text.replace(/\s*\r?\n\s*/g, ' ').trim();
  const block = index === null ? undefined : blocks[index];
  // An index the block list doesn't reach is as gone as a null one; saying `§43 undefined` would be
  // worse than saying the anchor is lost.
  if (!block) return `- (detached) ${comment.anchor.snippet}: "${text}"`;
  return `- §${block.index + 1} ${block.snippet}: "${text}"`;
}

export function buildPlanHandoff(i: PlanHandoffInput): string {
  const open = i.comments.filter((c) => c.comment.status === 'open' && !c.comment.sentAt);

  const out = [`Plan: ${i.planPath} — I edited it and left comments.`];

  out.push(`Changed blocks (${i.changed.length}):`);
  for (const b of i.changed) {
    out.push(label(b));
    // Verbatim, but normalised: a CRLF plan would otherwise put stray ^M into the bracketed paste.
    out.push(normalizeBlockSource(b.source));
  }

  if (i.removed > 0) out.push(`Removed blocks: ${i.removed}`);

  out.push(`Open comments (${open.length}):`);
  for (const c of open) out.push(commentLine(c, i.blocks));

  const commentsPath = i.planPath.replace(/\.md$/i, '.comments.json');
  out.push(
    `Please revise the plan file, reply to each comment in ${commentsPath}, and tell me what you changed.`,
  );
  return out.join('\n');
}
