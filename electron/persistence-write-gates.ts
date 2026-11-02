import type { SessionsParse } from '../src/persistence';
import { shouldPersistSessions } from '../src/persistence';
import { type PersistedScrollback, restoreScrollback } from '../src/scrollback-persistence';
import type { TimedMessagesFile } from '../src/timed-messages';

// A file a newer version wrote is never overwritten this run (architecture §Persisted formats).
class PersistedWriteGate {
  constructor(readonly writable: boolean) {}

  run<T>(write: () => T): T | undefined {
    return this.writable ? write() : undefined;
  }
}

export function sessionWriteGate(
  settings: { restoreSessions: boolean },
  parsed: SessionsParse,
): PersistedWriteGate {
  return new PersistedWriteGate(shouldPersistSessions(settings) && parsed.kind !== 'newer');
}

export function timedMessagesWriteGate(parsed: TimedMessagesFile): PersistedWriteGate {
  return new PersistedWriteGate(parsed.kind !== 'newer');
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
    const newer = restored?.kind === 'newer';
    this.refused.set(fileName, newer);
    return newer ? null : restored;
  }

  /** A write or delete of the file; skipped when a newer version wrote it. */
  run<T>(fileName: string, write: () => T): T | undefined {
    if (!this.refused.has(fileName)) this.restore(fileName);
    return this.refused.get(fileName) ? undefined : write();
  }
}
