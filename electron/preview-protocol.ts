/**
 * Host side of the `conduit-preview:` scheme (ADR 0005): the token table that gives each
 * workspace root its own web origin, the confinement verdict every request passes through,
 * and the per-session handler + request filter that enforce both.
 *
 * The renderer is never load-bearing for confinement — it only asks and renders the answer.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { protocol, type Session } from 'electron';
import { isInsideAnyRoot, realPathLeaf } from '../src/path-guard';
import {
  isPreviewUrl,
  PREVIEW_SCHEME,
  type PreviewReason,
  parsePreviewUrl,
  previewContentType,
} from '../src/preview-url';

export const PREVIEW_PARTITION = 'conduit-preview';
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * Must be called at module scope, before app ready, or Electron throws.
 *
 * No `stream: true`: `protocol.handle` returns a `Response`, whose body already streams —
 * the flag belongs to the deprecated `registerStreamProtocol` path and implying otherwise
 * sends the next reader looking for a handler that does not exist.
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
    },
  ]);
}

const tokenByRoot = new Map<string, string>();
const rootByToken = new Map<string, string>();

/** Mint (or recall) this run's opaque token for one workspace root. */
export function rootTokenFor(rootPath: string): string {
  const existing = tokenByRoot.get(rootPath);
  if (existing) return existing;
  const token = randomBytes(16).toString('hex');
  tokenByRoot.set(rootPath, token);
  rootByToken.set(token, rootPath);
  return token;
}

export function rootForToken(token: string): string | undefined {
  return rootByToken.get(token);
}

export type PreviewVerdict =
  | { ok: true; path: string; contentType: string }
  | { ok: false; reason: PreviewReason; status: 404 | 413 | 500; detail?: string };

/** `fs`-backed `stat` adapter for `previewVerdictForPath`, shared with `html:canPreview`. */
export function previewStat(p: string): { isFile: boolean; size: number } | null {
  try {
    const st = fs.statSync(p);
    return { isFile: st.isFile(), size: st.size };
  } catch {
    return null;
  }
}

/**
 * Pure, with `stat`/`realPath` injected so it needs no filesystem and no Electron.
 *
 * Containment is checked TWICE on purpose: `isInsideAnyRoot` is purely lexical and catches
 * `../..`, while only re-checking the symlink-resolved path catches a file (or parent dir)
 * inside the root that links outside it.
 */
export function previewVerdictForPath(
  absPath: string,
  roots: readonly string[],
  stat: (p: string) => { isFile: boolean; size: number } | null,
  realPath: (p: string) => string,
): PreviewVerdict {
  if (!isInsideAnyRoot(absPath, roots)) {
    return { ok: false, reason: 'blocked', status: 404, detail: 'Outside the open workspace.' };
  }
  const real = realPath(absPath);
  if (!isInsideAnyRoot(real, roots)) {
    return { ok: false, reason: 'blocked', status: 404, detail: 'Resolves outside the workspace.' };
  }
  const st = stat(real);
  if (!st?.isFile) {
    return { ok: false, reason: 'missing', status: 404, detail: 'No such file.' };
  }
  if (st.size > MAX_PREVIEW_BYTES) {
    return { ok: false, reason: 'too-large', status: 413, detail: 'Over the 8 MB preview limit.' };
  }
  return { ok: true, path: real, contentType: previewContentType(real) };
}

const REASON_TEXT: Record<PreviewReason, string> = {
  blocked: 'This file is outside every open workspace folder.',
  'too-large': 'This file is larger than the 8 MB preview limit.',
  missing: 'This file no longer exists.',
  unsupported: 'This is not a valid preview address.',
  unreadable: 'This file could not be read.',
};

/**
 * A `<webview>` surfaces no HTTP status, so a bare error body renders as a blank pane with
 * nothing to read. `protocol.handle` exposes no main-frame flag, so the stand-in is the
 * requested type: `text/html` — every main-frame load this feature produces, since a guest's
 * src is always a .html/.htm file — gets a recognisable error document, while a subresource
 * keeps the bare status, where a body would only be mis-parsed as CSS/JS.
 */
function failure(reason: PreviewReason, status: 404 | 413 | 500, contentType = ''): Response {
  if (contentType !== 'text/html') return new Response(null, { status });
  const body =
    `<!doctype html><meta charset="utf-8"><title>Preview unavailable</title>` +
    `<body data-conduit-preview-error="${reason}" style="font:14px/1.6 system-ui,sans-serif;margin:0;padding:28px;background:#14161a;color:#8a90a0">` +
    `<strong style="display:block;font-size:15px;color:#cdd3df;margin-bottom:6px">Preview unavailable</strong>${REASON_TEXT[reason]}</body>`;
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}

export function registerPreviewProtocol(
  ses: Session,
  getRoots: () => string[],
  isNetworkAllowed: (guestId: number | undefined) => boolean,
  onBlocked: (guestId: number | undefined, host: string) => void,
): void {
  ses.protocol.handle(PREVIEW_SCHEME, async (request) => {
    const parsed = parsePreviewUrl(request.url);
    if (!parsed) return failure('unsupported', 404);
    const leafType = previewContentType(parsed.segments[parsed.segments.length - 1]);

    const root = rootForToken(parsed.token);
    if (root === undefined) return failure('unsupported', 404, leafType);

    const verdict = previewVerdictForPath(
      path.join(root, ...parsed.segments),
      getRoots(),
      previewStat,
      realPathLeaf,
    );
    if (!verdict.ok) return failure(verdict.reason, verdict.status, leafType);

    try {
      const bytes = await fs.promises.readFile(verdict.path);
      return new Response(bytes, {
        headers: {
          'content-type': verdict.contentType,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return failure('unreadable', 500, verdict.contentType);
    }
  });

  // No-filter overload: `WebRequestFilter.urls` is required in the form that takes one.
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (isPreviewUrl(details.url) || isNetworkAllowed(details.webContentsId)) {
      callback({ cancel: false });
      return;
    }
    callback({ cancel: true });
    onBlocked(details.webContentsId, new URL(details.url).hostname);
  });
}
