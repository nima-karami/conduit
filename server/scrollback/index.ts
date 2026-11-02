import { unlink } from 'node:fs';
import { join } from 'node:path';
import { ScrollbackWriteGate } from '../../electron/persistence-write-gates';
import { atomicWriteFile } from '../../src/atomic-write';
import { readBlob } from '../../src/config';
import type { ScrollbackPort, ServerEventSink } from '../../src/contracts/server-ports';
import type { FirstPaint } from '../../src/contracts/terminal-link';
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
  write(fileName: string, blob: string): void;
  remove(fileName: string): void;
}

export function diskScrollbackFiles(dir: string, log: (message: string) => void): ScrollbackFiles {
  return {
    read: (fileName) => readBlob(join(dir, fileName)),
    write(fileName, blob) {
      atomicWriteFile(join(dir, fileName), blob, (error) => {
        if (error) log(`scrollback: write ${fileName} failed: ${String(error)}`);
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

  constructor(private readonly deps: ServerScrollbackDeps) {
    this.gate = new ScrollbackWriteGate((name) => deps.files.read(name));
    this.store = new ScrollbackStore(
      (sessionId, blob) => {
        if (!deps.recording()) return;
        const name = scrollbackFileName(sessionId);
        this.gate.run(name, () => deps.files.write(name, blob));
      },
      {
        send: (sessionId, data) => deps.emit('term.show', { sessionId, data }),
        recording: () => true,
      },
    );
  }

  /** PTY output from the active stream; the caller grants hc credit after this returns. */
  append(sessionId: string, data: string, size: TermGeometry | undefined): void {
    this.store.append(sessionId, data, size);
  }

  /** The ring never resets on a gap: it records that output may be missing, then the repaint. */
  gap(sessionId: string, paint: string, size: TermGeometry): void {
    this.store.append(sessionId, GAP_MARKER + paint, size);
  }

  replayForColdStart(sessionId: string): FirstPaint | null {
    const replay = this.store.replayForColdStart(
      sessionId,
      () => this.gate.restore(scrollbackFileName(sessionId))?.segments,
    );
    return replay?.data ? { data: replay.data, replay: replay.runs } : null;
  }

  show(sessionId: string, data: string): void {
    const size = this.deps.sizeOf(sessionId);
    if (size) this.store.show(sessionId, data, size);
    else {
      this.deps.emit('term.show', { sessionId, data });
      this.store.append(sessionId, data, undefined);
    }
  }

  record(sessionId: string, data: string): void {
    this.store.append(sessionId, data, this.deps.sizeOf(sessionId));
  }

  forget(sessionId: string): void {
    this.store.drop(sessionId);
    const name = scrollbackFileName(sessionId);
    this.gate.run(name, () => this.deps.files.remove(name));
  }

  flushPending(): void {
    this.store.flushPending();
  }
}
