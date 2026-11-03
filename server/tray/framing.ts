import {
  type HelperToSupervisor,
  type SupervisorToHelper,
  TRAY_LIMITS,
  TRAY_PROTOCOL_VERSION,
} from '../../src/contracts/tray-protocol';

const NL = 0x0a;

/**
 * Byte-level so a multi-byte char split across chunks decodes whole, and the 64 KiB limit is in
 * bytes as the Rust side counts it (spec §5 Rules). `error`: the first oversize line ends the
 * stream for good. `truncate`: for stderr, which is diagnostics only.
 */
export class LineDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private failed: Error | null = null;
  private discarding = false;

  constructor(
    private readonly maxBytes: number = TRAY_LIMITS.maxLineBytes,
    private readonly oversize: 'error' | 'truncate' = 'error',
  ) {}

  push(chunk: Buffer): { lines: string[]; error: Error | null } {
    const lines: string[] = [];
    if (this.failed) return { lines, error: this.failed };
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(NL, start);
      const end = nl === -1 ? chunk.length : nl;
      if (!this.take(chunk.subarray(start, end))) {
        if (this.oversize === 'error') {
          this.failed = new Error(`helper line over ${this.maxBytes} bytes`);
          return { lines, error: this.failed };
        }
        if (!this.discarding) lines.push(this.drain());
        this.discarding = true;
      }
      if (nl === -1) break;
      if (this.discarding) this.discarding = false;
      else lines.push(this.drain());
      start = nl + 1;
    }
    return { lines, error: null };
  }

  /** false once the current line would pass the limit. */
  private take(part: Buffer): boolean {
    if (this.discarding) return false;
    const room = this.maxBytes - this.pendingBytes;
    if (part.length > room) {
      if (room > 0) this.pending.push(part.subarray(0, room));
      this.pendingBytes = this.maxBytes;
      return false;
    }
    if (part.length) {
      this.pending.push(part);
      this.pendingBytes += part.length;
    }
    return true;
  }

  private drain(): string {
    const text = Buffer.concat(this.pending).toString('utf8');
    this.pending = [];
    this.pendingBytes = 0;
    return text.endsWith('\r') ? text.slice(0, -1) : text;
  }
}

export function encodeHelperLine(m: SupervisorToHelper): string {
  const line = JSON.stringify(m);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > TRAY_LIMITS.maxLineBytes)
    throw new RangeError(`${m.type} line is ${bytes} bytes, over ${TRAY_LIMITS.maxLineBytes}`);
  return `${line}\n`;
}

export type ParsedHelperLine = HelperToSupervisor | { type: 'unknown'; raw: string } | Error;

const isLevel = (v: unknown): v is 'info' | 'warn' | 'error' =>
  v === 'info' || v === 'warn' || v === 'error';

/** Rebuilds each known message from its checked fields, so nothing unvalidated reaches the relay. */
export function parseHelperLine(line: string): ParsedHelperLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return new Error(`helper line is not JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return new Error('helper line is not an object');
  const o = value as Record<string, unknown>;
  const bad = (what: string) => new Error(`helper ${String(o.type)}: ${what}`);
  switch (o.type) {
    case 'hello':
      if (o.v !== TRAY_PROTOCOL_VERSION) return bad(`protocol version ${String(o.v)}`);
      if (typeof o.helperVersion !== 'string' || typeof o.pid !== 'number')
        return bad('missing helperVersion/pid');
      return {
        type: 'hello',
        v: TRAY_PROTOCOL_VERSION,
        helperVersion: o.helperVersion,
        pid: o.pid,
      };
    case 'shown':
    case 'hidden':
    case 'stopAll':
    case 'opened':
      return { type: o.type };
    case 'openFailed':
      if (typeof o.reason !== 'string') return bad('missing reason');
      return { type: 'openFailed', reason: o.reason };
    case 'log':
      if (!isLevel(o.level) || typeof o.message !== 'string') return bad('bad level/message');
      return { type: 'log', level: o.level, message: o.message };
    default:
      if (typeof o.type !== 'string') return new Error('helper line has no type');
      return { type: 'unknown', raw: line };
  }
}
