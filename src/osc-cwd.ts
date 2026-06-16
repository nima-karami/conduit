/**
 * Parser for terminal OSC sequences that report the current working directory.
 * Host-only module — imports node:path (fine; never import this from the renderer).
 *
 * Supports:
 *  - OSC 7:     ESC ] 7 ; file://<host>/<path> ST
 *  - OSC 9;9:   ESC ] 9 ; 9 ; <path> ST  (Windows Terminal / ConEmu)
 *  - OSC 1337:  ESC ] 1337 ; CurrentDir=<path> ST  (iTerm2)
 *
 * ST = ESC \ (two chars) or BEL (\x07).
 */

// Normalize a path to forward-slash absolute (strip leading slash on Windows drive paths).
function normalizePath(p: string): string {
  // Replace backslashes with forward slashes.
  let s = p.replace(/\\/g, '/');
  // Windows: /C:/Users/... → C:/Users/...
  if (/^\/[A-Za-z]:\//.test(s)) {
    s = s.slice(1);
  }
  return s;
}

/**
 * Extract every cwd report in the chunk, in order. Returns the decoded absolute
 * local paths. Returns [] when none found.
 */
export function parseCwdReports(chunk: string): string[] {
  const results: string[] = [];
  // ST = ESC \ or BEL
  // OSC prefix = ESC ] or \x9d (C1 single char, rare; we handle only ESC ] for simplicity)
  const OSC_PREFIX = '\x1b]';
  const ESC_BACKSLASH = '\x1b\\';
  const BEL = '\x07';

  let i = 0;
  while (i < chunk.length) {
    const esc = chunk.indexOf(OSC_PREFIX, i);
    if (esc === -1) break;

    // Find the string terminator (ST = ESC\ or BEL).
    let stEnd = -1;
    let stLen = 0;
    const bel = chunk.indexOf(BEL, esc + 2);
    const escBs = chunk.indexOf(ESC_BACKSLASH, esc + 2);
    if (bel === -1 && escBs === -1) {
      // No ST found yet — partial sequence, stop (will be handled by CwdScanner buffer).
      break;
    }
    if (bel === -1) {
      stEnd = escBs;
      stLen = 2;
    } else if (escBs === -1) {
      stEnd = bel;
      stLen = 1;
    } else {
      // Pick whichever comes first.
      if (bel < escBs) {
        stEnd = bel;
        stLen = 1;
      } else {
        stEnd = escBs;
        stLen = 2;
      }
    }

    const body = chunk.slice(esc + 2, stEnd);
    const path = extractPath(body);
    if (path !== null) results.push(path);

    i = stEnd + stLen;
  }

  return results;
}

/** Extract a cwd path from an OSC body string, or null if it's not a cwd report. */
function extractPath(body: string): string | null {
  // OSC 7: "7;file://<host>/<path>"
  if (body.startsWith('7;')) {
    const rest = body.slice(2);
    return parseOsc7Url(rest);
  }

  // OSC 9;9: "9;9;<path>"
  if (body.startsWith('9;9;')) {
    const p = body.slice(4);
    if (p.length === 0) return null;
    return normalizePath(p);
  }

  // OSC 1337: "1337;CurrentDir=<path>"
  if (body.startsWith('1337;CurrentDir=')) {
    const p = body.slice('1337;CurrentDir='.length);
    if (p.length === 0) return null;
    return normalizePath(p);
  }

  return null;
}

/** Parse an OSC 7 file:// URL and return the local path, or null on failure. */
function parseOsc7Url(url: string): string | null {
  if (!url.startsWith('file://')) return null;
  // file://<host>/<path> where host may be empty (file:///path) or localhost.
  const withoutScheme = url.slice('file://'.length);
  // Find first slash after the host part.
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx === -1) return null;
  const pathPart = withoutScheme.slice(slashIdx); // includes leading /
  // Percent-decode.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }
  return normalizePath(decoded);
}

/**
 * Stateful per-session scanner that handles OSC sequences split across chunks.
 * Keep one per session; call push() for each data chunk; it returns the last
 * complete cwd found, or null.
 *
 * The buffer is bounded to ~4 KB to avoid unbounded growth. When the buffer
 * exceeds the cap, the front is trimmed beyond any partial-OSC boundary so
 * incomplete sequences at the tail are preserved.
 */
const BUFFER_CAP = 4096;

export class CwdScanner {
  private buf = '';

  push(chunk: string): string | null {
    this.buf += chunk;

    // Trim the buffer from the front if it's too large, preserving any trailing
    // partial OSC sequence that might be continued in the next chunk.
    if (this.buf.length > BUFFER_CAP) {
      const excess = this.buf.length - BUFFER_CAP;
      // Find the latest ESC ] start within the front half to trim up to.
      const searchFrom = Math.max(0, excess - 100);
      const lastOsc = this.buf.lastIndexOf('\x1b]', excess + 100);
      if (lastOsc > searchFrom) {
        this.buf = this.buf.slice(lastOsc);
      } else {
        this.buf = this.buf.slice(excess);
      }
    }

    const paths = parseCwdReports(this.buf);

    // Trim completed sequences from the buffer; keep only the trailing partial.
    // We do this by finding the last terminated OSC and dropping everything up to it.
    this.buf = retainPartialTail(this.buf);

    if (paths.length === 0) return null;
    return paths[paths.length - 1];
  }
}

/**
 * Given a chunk (possibly with completed OSC sequences + a trailing partial),
 * return only the part after the last complete sequence (i.e. the partial tail).
 * This prevents the buffer from growing with already-processed data.
 */
function retainPartialTail(buf: string): string {
  const ESC_BACKSLASH = '\x1b\\';
  const BEL = '\x07';

  let lastEnd = -1;

  let i = 0;
  while (i < buf.length) {
    const esc = buf.indexOf('\x1b]', i);
    if (esc === -1) break;

    const bel = buf.indexOf(BEL, esc + 2);
    const escBs = buf.indexOf(ESC_BACKSLASH, esc + 2);

    if (bel === -1 && escBs === -1) {
      // Partial sequence — stop here.
      break;
    }

    let stEnd: number;
    let stLen: number;
    if (bel === -1) {
      stEnd = escBs;
      stLen = 2;
    } else if (escBs === -1) {
      stEnd = bel;
      stLen = 1;
    } else if (bel < escBs) {
      stEnd = bel;
      stLen = 1;
    } else {
      stEnd = escBs;
      stLen = 2;
    }

    lastEnd = stEnd + stLen;
    i = lastEnd;
  }

  // Keep only the part after the last completed sequence.
  if (lastEnd > 0) {
    return buf.slice(lastEnd);
  }
  return buf;
}
