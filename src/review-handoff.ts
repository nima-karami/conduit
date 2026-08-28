import type { ReviewNote } from './review-notes';

/**
 * The agent handoff (spec 2026-08-27-review-supercharge §2 Lane F). Pure and node-free so the
 * exact bytes that reach a terminal are unit-testable — the delivery is a bracketed paste with NO
 * trailing newline, because a trailing newline is what makes some TUIs submit, and the spec is
 * explicit that the user presses Enter.
 */

/** Continuation lines are indented so a multi-line body stays inside its markdown list item. */
const indentBody = (body: string): string => body.trimEnd().split('\n').join('\n  ');

export function buildHandoffMarkdown(
  notes: readonly ReviewNote[],
  files: readonly string[],
  sourceLabel: string,
): string {
  if (notes.length === 0) return '';

  const byPath = new Map<string, ReviewNote[]>();
  for (const n of notes) {
    const list = byPath.get(n.path);
    if (list) list.push(n);
    else byPath.set(n.path, [n]);
  }

  // The reviewer's own order first; anything the file list doesn't mention (a path that scrolled
  // out of the changeset since the note was written) is appended rather than silently dropped.
  const ordered = [
    ...files.filter((f) => byPath.has(f)),
    ...[...byPath.keys()].filter((p) => !files.includes(p)),
  ];

  const out: string[] = [
    `Review notes on ${ordered.length} file${ordered.length === 1 ? '' : 's'} (${sourceLabel}):`,
  ];
  for (const path of ordered) {
    const list = [...(byPath.get(path) ?? [])].sort((a, b) => a.line - b.line);
    out.push('', `### ${path}`);
    for (const n of list) out.push(`- L${n.line} (\`${n.snippet}\`): ${indentBody(n.body)}`);
  }
  out.push('', 'Please address these and reply with what you changed.');
  return out.join('\n');
}

/** What the footer control says. One place, so the button and its tooltip can't disagree (§8). */
export function handoffLabel(
  pending: number,
  live: boolean,
): { label: string; title: string; disabled: boolean } {
  if (!live) {
    return {
      label: 'Copy as markdown',
      title: 'This session has no live terminal — copy the notes and paste them yourself',
      disabled: pending === 0,
    };
  }
  return {
    label: `Send to agent (${pending})`,
    title: `Paste ${pending} open note${pending === 1 ? '' : 's'} into this session (you press Enter)`,
    disabled: pending === 0,
  };
}
