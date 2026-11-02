import { unlink } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../../src/atomic-write';
import { readBlob } from '../../src/config';
import type { ScrollbackPort, ServerEventSink } from '../../src/contracts/server-ports';
import type { FirstPaint } from '../../src/contracts/terminal-link';
import { ScrollbackWriteGate } from '../../src/persistence-write-gates';
import type { TermGeometry } from '../../src/protocol';
import { scrollbackFileName } from '../../src/scrollback-files';
import { ScrollbackStore } from '../../src/scrollback-store';

/**
 * Appended before a `paint{cause:'gap'}`: output between the last byte and the repaint may be
 * missing, and a later cold replay must show that rather than splice two screens (D18).
 */
export const GAP_MARKER = '\r\n\x1b[2m— output may be missing here —\x1b[0m\r\n';

export interface ScrollbackFiles {
  read(fileName: string): string | undefined;
  write(fileName: string, blob: string): void | Promise<void>;
  remove(fileName: string): void;
}

export function diskScrollbackFiles(dir: string, log: (message: string) => void): ScrollbackFiles {
  return {
    read: (fileName) => readBlob(join(dir, fileName)),
    write(fileName, blob) {
      return new Promise<void>((resolve, reject) => {
        atomicWriteFile(join(dir, fileName), blob, (error) => {
          if (error) {
            log(`scrollback: write ${fileName} failed: ${String(error)}`);
            reject(error);
          } else resolve();
        });
      });
    },
    remove(fileName) {
      unlink(join(dir, fileName), () => {});
    },
  };
}

export interface ServerScrollbackDeps {
  files: ScrollbackFiles;
  emit: ServerEventSink;
  /** The session's current PTY size, else its last requested one: host bytes are recorded at it. */
  sizeOf(sessionId: string): TermGeometry | undefined;
  /** `scrollbackPersistence`: the ring is kept in memory regardless, only the file is gated. */
  recording(): boolean;
}

/** The ring + files (D18). The runtime appends on its credit path; W4 uses the ScrollbackPort half. */
export class ServerScrollback implements ScrollbackPort {
  private readonly store: ScrollbackStore;
  /** A file a newer version wrote is never read back or overwritten this run. */
  private readonly gate: ScrollbackWriteGate;
  private readonly hydrated = new Set<string>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private writeFailure: { error: unknown } | undefined;

  constructor(private readonly deps: ServerScrollbackDeps) {
    this.gate = new ScrollbackWriteGate((name) => deps.files.read(name));
    this.store = new ScrollbackStore(
      (sessionId, blob) => {
        if (!deps.recording()) return;
        const name = scrollbackFileName(sessionId);
        this.gate.run(name, () => this.trackWrite(() => deps.files.write(name, blob)));
      },
      {
        send: (sessionId, data) => deps.emit('term.show', { sessionId, data }),
        recording: () => true,
      },
    );
  }

  /** PTY output from the active stream; the caller grants hc credit after this returns. */
  append(sessionId: string, data: string, size: TermGeometry | undefined): void {
    this.hydrate(sessionId);
    this.store.append(sessionId, data, size);
  }

  /** The ring never resets on a gap: it records that output may be missing, then the repaint. */
  gap(sessionId: string, paint: string, size: TermGeometry): void {
    this.append(sessionId, GAP_MARKER + paint, size);
  }

  /** Ends the current segment even if nothing follows: a cold replay resizes there too. */
  resized(sessionId: string, size: TermGeometry): void {
    this.append(sessionId, '', size);
  }

  /** A launch is about to run: what the ring holds now precedes it (`replayBeforeLaunch`). */
  launchStarted(sessionId: string): void {
    this.hydrate(sessionId);
    this.store.markLaunch(sessionId);
  }

  replayBeforeLaunch(sessionId: string): FirstPaint | null {
    this.hydrate(sessionId);
    const replay = this.store.replayBeforeLaunch(sessionId);
    return replay ? { data: replay.data, replay: replay.runs } : null;
  }

  replayForColdStart(sessionId: string): FirstPaint | null {
    this.hydrate(sessionId);
    const replay = this.store.replayForColdStart(sessionId, () => undefined);
    return replay?.data ? { data: replay.data, replay: replay.runs } : null;
  }

  show(sessionId: string, data: string): void {
    this.hydrate(sessionId);
    const size = this.deps.sizeOf(sessionId);
    if (size) this.store.show(sessionId, data, size);
    else {
      this.deps.emit('term.show', { sessionId, data });
      this.store.append(sessionId, data, undefined);
    }
  }

  record(sessionId: string, data: string): void {
    this.append(sessionId, data, this.deps.sizeOf(sessionId));
  }

  forget(sessionId: string): void {
    this.store.drop(sessionId);
    this.hydrated.delete(sessionId);
    const name = scrollbackFileName(sessionId);
    this.gate.run(name, () => this.deps.files.remove(name));
  }

  async flushPending(): Promise<void> {
    this.store.flushPending();
    await Promise.all([...this.pendingWrites]);
    if (this.writeFailure) throw this.writeFailure.error;
  }

  private hydrate(sessionId: string): void {
    if (this.hydrated.has(sessionId)) return;
    this.hydrated.add(sessionId);
    const restored = this.gate.restore(scrollbackFileName(sessionId));
    for (const segment of restored?.segments ?? [])
      this.store.append(sessionId, segment.data, segment.geometry);
    if (restored?.beforeLaunch !== undefined)
      this.store.markLaunch(sessionId, restored.beforeLaunch);
  }

  private trackWrite(write: () => void | Promise<void>): void {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(write());
    } catch (error) {
      pending = Promise.reject(error);
    }
    this.pendingWrites.add(pending);
    void pending.then(
      () => this.pendingWrites.delete(pending),
      (error) => {
        this.writeFailure ??= { error };
        this.pendingWrites.delete(pending);
      },
    );
  }
}
