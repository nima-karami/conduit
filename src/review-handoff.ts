import type { AnchoredNote } from './review-notes';

/**
 * The agent handoff (spec 2026-08-27-review-supercharge §2 Lane F). Pure and node-free so the
 * exact bytes that reach a terminal are unit-testable — the delivery is a bracketed paste with NO
 * trailing newline, because a trailing newline is what makes some TUIs submit, and the spec is
 * explicit that the user presses Enter.
 */

/** Continuation lines are indented so a multi-line body stays inside its markdown list item. */
const indentBody = (body: string): string => body.trimEnd().split('\n').join('\n  ');

/**
 * One note as a list item. The line is the RE-ANCHORED one, never the stored one: `reanchor` is
 * view-only and deliberately never rewrites `note.line` (plan assumption 4), so a note written
 * before an edit above it still carries its original line in the store. Telling the agent to look
 * at a line the code has moved off is worse than telling it nothing. A note whose anchor is gone
 * says so rather than quoting a line number that no longer means anything.
 */
function item({ note, line }: AnchoredNote): string {
  const body = indentBody(note.body);
  if (line === null)
    return `- (was line ${note.line}: \`${note.snippet}\` — that line is gone): ${body}`;
  return `- L${line} (\`${note.snippet}\`): ${body}`;
}

export function buildHandoffMarkdown(
  notes: readonly AnchoredNote[],
  files: readonly string[],
  sourceLabel: string,
): string {
  if (notes.length === 0) return '';

  const byPath = new Map<string, AnchoredNote[]>();
  for (const n of notes) {
    const list = byPath.get(n.note.path);
    if (list) list.push(n);
    else byPath.set(n.note.path, [n]);
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
    // Detached notes last: they have no line to sort by, and the agent can act on the located
    // ones first.
    const list = [...(byPath.get(path) ?? [])].sort(
      (a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER),
    );
    out.push('', `### ${path}`);
    for (const n of list) out.push(item(n));
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
      title:
        'This session has no terminal ready to take a multi-line paste — copy the notes and paste them yourself',
      disabled: pending === 0,
    };
  }
  return {
    label: `Send to agent (${pending})`,
    title: `Paste ${pending} open note${pending === 1 ? '' : 's'} into this session (you press Enter)`,
    disabled: pending === 0,
  };
}
