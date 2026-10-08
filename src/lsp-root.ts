// Which server a file belongs to. See docs/specs/2026-09-22-language-server-go.md §2.3.
import { posix, win32 } from 'node:path';
import { canonicalPath, hasDotSegment } from './canonical-path';
import type { HostPlatform } from './lsp-binary';
import {
  compileRootMarker,
  isPatternMarker,
  type LanguageServerSpec,
  primaryLanguageId,
} from './lsp-registry';

export interface RootProbe {
  exists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  /** Entry names of `dir`; `[]` when it can't be read. */
  list(dir: string): Promise<string[]>;
}

export interface ServerRoot {
  /** `serverKeyFor(languageId, realRoot)` — dedupe only. */
  key: string;
  realRoot: string;
  /** The root in the DOC-PATH spelling: what the server is given, so its root URI and the doc
   *  URIs agree under a junction/subst. */
  root: string;
  workspaceRoot: string;
  adHoc: boolean;
}

/** The file is inside a workspace, but its module's folder resolves (symlink/junction) outside
 *  it — refused, and told apart from "not in any project" so the message can say why. */
export interface EscapedRoot {
  escapesWorkspace: true;
}

export type RootResolution = ServerRoot | EscapedRoot | null;

export const isEscapedRoot = (r: RootResolution): r is EscapedRoot =>
  r !== null && 'escapesWorkspace' in r;

const pathFor = (platform: HostPlatform) => (platform === 'win32' ? win32 : posix);
const sepFor = (platform: HostPlatform) => (platform === 'win32' ? '\\' : '/');

function norm(p: string, platform: HostPlatform): string {
  if (platform !== 'win32') return p.length > 1 ? p.replace(/\/+$/, '') : p;
  const n = canonicalPath(p).replace(/\//g, '\\').toLowerCase();
  return /^[a-z]:\\$/.test(n) ? n : n.replace(/\\+$/, '');
}

export function isWithin(child: string, parent: string, platform: HostPlatform): boolean {
  const c = norm(child, platform);
  const p = norm(parent, platform);
  if (c === p) return true;
  return c.startsWith(p.endsWith(sepFor(platform)) ? p : p + sepFor(platform));
}

export function serverKeyFor(languageId: string, realRoot: string): string {
  return `${languageId}:${realRoot}`;
}

export function toLexicalPath(
  path: string,
  realRoot: string,
  lexicalRoot: string,
  platform: HostPlatform,
): string {
  if (realRoot === lexicalRoot || !isWithin(path, realRoot, platform)) return path;
  const tail = canonicalPath(path)
    .slice(norm(realRoot, platform).length)
    .replace(/^[\\/]*/, '');
  const base = canonicalPath(lexicalRoot).replace(/[\\/]+$/, '');
  return tail ? `${base}${sepFor(platform)}${tail}` : base;
}

/** Exact markers are probed by path; a directory is listed only for a pattern marker, and at most
 *  once (`listing` is shared by one ancestor's workspace and module checks). */
async function anyExists(
  dir: string,
  markers: readonly CompiledMarker[],
  platform: HostPlatform,
  probe: RootProbe,
  listing: () => Promise<readonly string[]>,
) {
  for (const m of markers) {
    if (m.pattern) {
      if ((await listing()).some(m.pattern)) return true;
    } else if (await probe.exists(pathFor(platform).join(dir, m.name))) return true;
  }
  return false;
}

interface CompiledMarker {
  name: string;
  pattern: ((base: string) => boolean) | null;
}

const compileMarkers = (markers: readonly string[]): CompiledMarker[] =>
  markers.map((name) => ({
    name,
    pattern: isPatternMarker(name) ? compileRootMarker(name) : null,
  }));

function onceListing(dir: string, probe: RootProbe): () => Promise<readonly string[]> {
  let entries: Promise<readonly string[]> | null = null;
  return () => {
    entries ??= probe.list(dir);
    return entries;
  };
}

export async function resolveServerRoot(
  filePath: string,
  workspaceRoots: readonly string[],
  spec: Pick<LanguageServerSpec, 'languageIds' | 'rootMarkers' | 'requiresMarker'>,
  probe: RootProbe,
  platform: HostPlatform,
): Promise<RootResolution> {
  const path = pathFor(platform);
  const file = platform === 'win32' ? canonicalPath(filePath) : filePath;
  if (hasDotSegment(file)) return null;
  const containing = workspaceRoots
    .filter((w) => isWithin(file, w, platform) && norm(file, platform) !== norm(w, platform))
    .sort((a, b) => norm(b, platform).length - norm(a, platform).length);
  const workspace = containing[0];
  if (workspace === undefined) return null;
  const wsLen = norm(workspace, platform).length;

  let highestWorkspace: string | null = null;
  let nearestModule: string | null = null;
  const workspaceMarkers = compileMarkers(spec.rootMarkers.workspace);
  const moduleMarkers = compileMarkers(spec.rootMarkers.module);
  let dir = path.dirname(file);
  for (;;) {
    const listing = onceListing(dir, probe);
    if (await anyExists(dir, workspaceMarkers, platform, probe, listing)) highestWorkspace = dir;
    if (nearestModule === null && (await anyExists(dir, moduleMarkers, platform, probe, listing))) {
      nearestModule = dir;
    }
    if (norm(dir, platform).length <= wsLen) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (spec.requiresMarker && highestWorkspace === null && nearestModule === null) return null;
  // The workspace root re-spelled from the file path itself, so the ad-hoc root keeps the doc's spelling.
  const lexicalWorkspace = file.slice(0, wsLen) || workspace;
  const root = highestWorkspace ?? nearestModule ?? lexicalWorkspace;
  // Lexical containment above, realpath containment here — a symlink or junction inside the
  // workspace must not root a server (cwd, `go list`, recursive watch) outside it. Same standard
  // as the preview scheme (ADR 0005).
  let realRoot: string;
  let realWorkspace: string;
  try {
    realRoot = await probe.realpath(root);
    realWorkspace = await probe.realpath(workspace);
  } catch {
    return null;
  }
  if (platform === 'win32') {
    realRoot = canonicalPath(realRoot);
    realWorkspace = canonicalPath(realWorkspace);
  }
  if (!isWithin(realRoot, realWorkspace, platform)) return { escapesWorkspace: true };
  return {
    key: serverKeyFor(primaryLanguageId(spec), realRoot),
    realRoot,
    root,
    workspaceRoot: workspace,
    adHoc: highestWorkspace === null && nearestModule === null,
  };
}
