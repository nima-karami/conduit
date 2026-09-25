import { normalizeRoot } from './review-marks';

/** One key per folder; see mf-model spec §2.3 "Folder key". String-only, never platform-keyed. */
export function folderKey(p: string): string {
  const r = normalizeRoot(p);
  return r.startsWith('//') ? r.toLowerCase() : r;
}
