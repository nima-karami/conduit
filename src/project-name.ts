const MAX_NAME = 80;

/** Trim, collapse whitespace runs to one space; 1..80 chars → the name, else null. The one
 *  naming rule, shared by the host's ProjectStore and every renderer input that names one. */
export function normalizeProjectName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= MAX_NAME ? name : null;
}

/** Rename commit: the normalized draft when it is valid and differs from `current`, else null (no post). */
export function renamedProjectName(draft: string, current: string): string | null {
  const name = normalizeProjectName(draft);
  return name !== null && name !== current ? name : null;
}
