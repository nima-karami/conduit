import type { SessionsParse } from './persistence';
import { shouldPersistSessions } from './persistence';
import { type PersistedScrollback, restoreScrollback } from './scrollback-persistence';
import type { TimedMessagesFile } from './timed-messages';

// A file a newer version wrote is never overwritten this run (architecture §Persisted formats).
export function sessionsWritable(
  settings: { restoreSessions: boolean },
  parsed: SessionsParse,
): boolean {
  return shouldPersistSessions(settings) && parsed.kind !== 'newer';
}

export function timedMessagesWritable(parsed: TimedMessagesFile): boolean {
  return parsed.kind !== 'newer';
}

/**
 * Judges each scrollback file once, on first touch, so a persist doesn't re-read its own file:
 * once this run writes it, it is ours.
 */
export class ScrollbackWriteGate {
  private readonly refused = new Map<string, boolean>();

  constructor(private readonly readFile: (fileName: string) => string | undefined) {}

  /** The file's ring; null when there is none or a newer version wrote it. */
  restore(fileName: string): PersistedScrollback | null {
    const restored = restoreScrollback(this.readFile(fileName));
    this.refused.set(fileName, restored.kind === 'newer');
    return restored.kind === 'ok' ? restored.scrollback : null;
  }

  /** A write or delete of the file; skipped when a newer version wrote it. */
  run<T>(fileName: string, write: () => T): T | undefined {
    if (!this.refused.has(fileName)) this.restore(fileName);
    return this.refused.get(fileName) ? undefined : write();
  }
}
