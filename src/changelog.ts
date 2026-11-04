export function changelogSection(markdown: string, version: string): string | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => {
    const heading = /^## \[([^\]]+)\](?:\s+.*)?$/.exec(line);
    return heading?.[1] === version;
  });
  if (headingIndex < 0) return null;

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^## \[/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  const body = lines
    .slice(headingIndex + 1, endIndex)
    .join('\n')
    .trim();
  return body || null;
}

export interface ChangelogEntry {
  version: string;
  /** `YYYY-MM-DD` as written in the heading, or null when the heading carries none. */
  date: string | null;
  body: string;
  /** False for a `[YANKED]` heading — Keep a Changelog's marker, used here for a version that
   *  was tagged but never shipped, so it has no GitHub release to link to. */
  published: boolean;
}

/** Every released version's section, newest first as the file orders them. `[Unreleased]` and
 *  headings that name no version (the pre-versioning dev log) are skipped, and end the section
 *  above them rather than being folded into it. */
export function changelogEntries(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: { version: string; date: string | null; published: boolean } | null = null;
  let body: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current) entries.push({ ...current, body: body.join('\n').trim() });
    current = null;
    body = [];
  };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark && (fence === null || fenceMark.startsWith(fence))) {
      fence = fence === null ? fenceMark : null;
    } else if (fence === null && /^#{1,2}\s/.test(line)) {
      flush();
      const heading = /^## \[([^\]]+)\](.*)$/.exec(line);
      const version = heading?.[1].trim();
      if (heading && version && version.toLowerCase() !== 'unreleased') {
        const rest = heading[2];
        current = {
          version: version.replace(/^v/i, ''),
          date: /\b(\d{4}-\d{2}-\d{2})\b/.exec(rest)?.[1] ?? null,
          published: !/\[yanked\]/i.test(rest),
        };
      }
      continue;
    }
    if (current) body.push(line);
  }
  flush();
  return entries;
}

/** The installed version's entry when the changelog has it, else the newest. */
export function defaultEntryIndex(entries: readonly ChangelogEntry[], installed?: string): number {
  const at = installed ? entries.findIndex((e) => e.version === installed) : -1;
  return at < 0 ? 0 : at;
}

/** A `YYYY-MM-DD` heading date for display. `omitYear` drops the year when it matches. */
export function releaseDateLabel(
  date: string,
  style: 'short' | 'long',
  omitYear?: string,
  locale?: string,
): string {
  const [y, m, d] = date.split('-').map(Number);
  const when = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(when.getTime())) return date;
  return new Intl.DateTimeFormat(locale, {
    month: style,
    day: 'numeric',
    year: omitYear && date.startsWith(`${omitYear}-`) ? undefined : 'numeric',
    timeZone: 'UTC',
  }).format(when);
}
