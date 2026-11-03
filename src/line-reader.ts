/**
 * Newline-framed reader over socket chunks. Linear: only a new chunk is scanned for the newline
 * and a partial line is kept as a chunk list, so a large line is joined once, not re-copied per
 * chunk. A line past `maxBytes` (complete or still growing) is refused, not buffered.
 */
export class LineReader {
  private parts: Buffer[] = [];
  private partBytes = 0;
  private overflowed = false;

  constructor(
    private readonly maxBytes: () => number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  /** `proceed` is asked before each line, so a caller that closes mid-chunk stops delivery. */
  write(chunk: Buffer, proceed: () => boolean = () => true): void {
    let start = 0;
    while (!this.overflowed && proceed()) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      const tail = chunk.subarray(start, nl);
      if (this.partBytes + tail.length > this.maxBytes()) {
        this.overflow();
        return;
      }
      const line =
        this.parts.length === 0
          ? tail
          : Buffer.concat([...this.parts, tail], this.partBytes + tail.length);
      this.parts = [];
      this.partBytes = 0;
      start = nl + 1;
      this.onLine(line.toString('utf8'));
    }
    if (this.overflowed || !proceed()) return;
    const rest = chunk.subarray(start);
    if (!rest.length) return;
    this.parts.push(rest);
    this.partBytes += rest.length;
    if (this.partBytes > this.maxBytes()) this.overflow();
  }

  private overflow(): void {
    this.overflowed = true;
    this.parts = [];
    this.partBytes = 0;
    this.onOverflow();
  }
}
