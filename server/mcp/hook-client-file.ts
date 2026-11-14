// The Claude hook client every launch's --settings points at. A live agent keeps calling the path
// it was launched with, through app updates that replace the install dir, so the client is copied
// once per content into userData and that copy is never rewritten.
// see docs/runs/2026-11-13-con-11/blockers.md (hook client packaging)
import { createHash } from 'node:crypto';
import * as path from 'node:path';

const HOOK_CLIENT_LEAF = 'conduit-hook.cjs';

export interface HookClientFs {
  read(p: string): Buffer | null;
  exists(p: string): boolean;
  writeAtomic(p: string, data: Buffer): void;
  mkdir(p: string): void;
}

/** The content-addressed copy's path, or null when the source can't be read or copied (no hooks then). */
export function ensureHookClient(i: {
  sourceDir: string;
  targetDir: string;
  fs: HookClientFs;
  warn(message: string, data: Record<string, unknown>): void;
}): string | null {
  const source = path.join(i.sourceDir, HOOK_CLIENT_LEAF);
  const data = i.fs.read(source);
  if (data === null) {
    i.warn('hook client missing; Claude hooks not injected', { source });
    return null;
  }
  const digest = createHash('sha256').update(data).digest('hex').slice(0, 16);
  const target = path.join(i.targetDir, `conduit-hook-${digest}.cjs`);
  if (i.fs.exists(target)) return target;
  try {
    i.fs.mkdir(i.targetDir);
    i.fs.writeAtomic(target, data);
    return target;
  } catch (err) {
    i.warn('hook client copy failed; Claude hooks not injected', { target, err: String(err) });
    return null;
  }
}
