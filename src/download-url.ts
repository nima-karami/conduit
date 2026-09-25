// Chromium's drag-download data (os-drag-out spec §2.4). Node-free: the renderer builds it at
// dragstart, and both path styles must work wherever the code runs (CI is Linux).

type Parsed = { host: string; segments: string[] };

function parseAbsolute(absPath: string): Parsed | null {
  const drive = /^([A-Za-z]:)[\\/]/.exec(absPath);
  if (drive) {
    const rest = absPath.slice(drive[0].length).split(/[\\/]+/);
    return { host: '', segments: [drive[1], ...rest] };
  }
  if (/^[\\/]{2}[^\\/]/.test(absPath)) {
    const [host, ...segments] = absPath.slice(2).split(/[\\/]+/);
    return { host, segments };
  }
  if (absPath.startsWith('/')) return { host: '', segments: absPath.slice(1).split(/\/+/) };
  return null;
}

const encodeSegment = (s: string) => (/^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s));

function toUrl({ host, segments }: Parsed): string {
  return `file://${host}/${segments.map(encodeSegment).join('/')}`;
}

export function fileUrlFor(absPath: string): string {
  const parsed = parseAbsolute(absPath);
  if (!parsed) throw new Error(`not an absolute path: ${absPath}`);
  return toUrl(parsed);
}

/** `application/octet-stream:<name>:<file url>`, or null when the path can't be expressed:
 *  not absolute, no file name, or a name holding the ':' that delimits the triple. */
export function downloadUrlFor(absPath: string): string | null {
  const parsed = parseAbsolute(absPath);
  const name = parsed?.segments.at(-1);
  if (!parsed || !name || name.includes(':')) return null;
  return `application/octet-stream:${name}:${toUrl(parsed)}`;
}
