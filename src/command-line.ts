import type { HostPlatform } from './lsp-binary';

const isSpace = (c: string) => c === ' ' || c === '\t';

/** CommandLineToArgvW's backslash/quote rules; see the mf-new-session plan Contracts. */
function splitWin32(line: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (isSpace(c) && !quoted) {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    cur ??= '';
    if (c === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          cur += '"';
          i += n;
        } else {
          i += n - 1;
        }
      } else {
        cur += '\\'.repeat(n);
        i += n - 1;
      }
    } else if (c === '"') {
      quoted = !quoted;
    } else {
      cur += c;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

const POSIX_DQ_ESCAPABLE = new Set(['"', '\\', '$', '`']);

function splitPosix(line: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (isSpace(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    cur ??= '';
    if (c === '\\') {
      if (i + 1 < line.length) cur += line[++i];
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      cur += line.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && POSIX_DQ_ESCAPABLE.has(line[i + 1])) i++;
        cur += line[i];
        i++;
      }
    } else {
      cur += c;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

export function splitCommandLine(line: string, platform: HostPlatform): string[] {
  return platform === 'win32' ? splitWin32(line) : splitPosix(line);
}
