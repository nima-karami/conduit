// Pure role-brief core, node-free so the renderer can import it (docs/specs/2026-10-26-conduit-role-brief.md §3).
import type { BriefSupport } from './conduit-mcp/adapters';
import { firstCmdMetachar } from './launch-args';
import type { AgentBriefSource, BriefError, BriefState } from './types';

export const BRIEF_MAX_BYTES = 65_536;
export const BRIEF_PREVIEW_DIR = '…/briefs/<id>';

export function briefPrompt(briefFile: string): string {
  return `Read your role brief at ${briefFile} and follow it.`;
}

export function parseBriefField(
  raw: unknown,
  ctx: { agentsDir: string; homeDir: string; resolve: (...p: string[]) => string },
): AgentBriefSource | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return { kind: 'text', text: raw };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'invalid';
  const keys = Object.keys(raw);
  const file = (raw as { file?: unknown }).file;
  if (keys.length !== 1 || keys[0] !== 'file' || typeof file !== 'string' || file === '') {
    return 'invalid';
  }
  return {
    kind: 'file',
    path: file.startsWith('~/')
      ? ctx.resolve(ctx.homeDir, file.slice(2))
      : ctx.resolve(ctx.agentsDir, file),
  };
}

export type DecodedBrief =
  | { ok: true; text: string | null }
  | { ok: false; error: 'brief-too-large' | 'brief-invalid' };

export function decodeBrief(bytes: Uint8Array): DecodedBrief {
  let text: string;
  try {
    // The default decoder drops a leading BOM; fatal turns invalid UTF-8 into a throw.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: 'brief-invalid' };
  }
  if (text.includes('\0')) return { ok: false, error: 'brief-invalid' };
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, text: null };
  if (new TextEncoder().encode(trimmed).length > BRIEF_MAX_BYTES) {
    return { ok: false, error: 'brief-too-large' };
  }
  return { ok: true, text };
}

export function decodeBriefText(text: string): DecodedBrief {
  return decodeBrief(new TextEncoder().encode(text));
}

export function briefByteCount(text: string): number {
  return new TextEncoder().encode(text.trim()).length;
}

export function briefArgs(
  support: BriefSupport,
  p: { briefDir: string; briefFile: string; sendPrompt: boolean },
): string[] {
  return [
    ...(support.readAccess === 'add-dir' ? ['--add-dir', p.briefDir] : []),
    // `--` ends option parsing so the prompt is never read as a flag value (plan, settled decisions).
    ...(p.sendPrompt ? ['--', briefPrompt(p.briefFile)] : []),
  ];
}

export function briefPreviewArgs(support: BriefSupport): string[] {
  return briefArgs(support, {
    briefDir: BRIEF_PREVIEW_DIR,
    briefFile: `${BRIEF_PREVIEW_DIR}/brief.md`,
    sendPrompt: true,
  });
}

export type BriefDrop = { code: 'file-missing' } | { code: 'cmd-metachar'; char: string };
export type BriefSpawnPlan =
  | { kind: 'none' }
  | { kind: 'args'; sendPrompt: boolean }
  | { kind: 'clear'; drop: BriefDrop; banner: boolean };

export function planBriefSpawn(i: {
  state: BriefState | undefined;
  support: BriefSupport | null;
  canonicalExists: boolean;
  guarded: boolean;
  briefDir: string;
  briefFile: string;
}): BriefSpawnPlan {
  if (i.state === undefined || i.support === null) return { kind: 'none' };
  // Only a pending brief was still owed to the user, so only it earns a banner (plan, settled decisions).
  const banner = i.state === 'pending';
  if (!i.canonicalExists) return { kind: 'clear', drop: { code: 'file-missing' }, banner };
  if (i.guarded) {
    const char = firstCmdMetachar(briefPrompt(i.briefFile)) ?? firstCmdMetachar(i.briefDir);
    if (char !== undefined) return { kind: 'clear', drop: { code: 'cmd-metachar', char }, banner };
  }
  return { kind: 'args', sendPrompt: banner };
}

export type BriefBannerReason =
  | BriefDrop
  | { code: BriefError }
  | { code: 'rebuild-failed' }
  | { code: 'copy-failed' };

export function briefBanner(r: BriefBannerReason): string {
  return `\r\n\x1b[2m— role brief not sent: ${reasonText(r)} —\x1b[0m\r\n`;
}

function reasonText(r: BriefBannerReason): string {
  switch (r.code) {
    case 'file-missing':
      return 'file missing';
    case 'cmd-metachar':
      return `path has "${r.char}"`;
    case 'brief-unreadable':
      return "can't read the file";
    case 'brief-too-large':
      return 'over 64 KiB';
    case 'brief-invalid':
      return 'not UTF-8 text';
    case 'brief-io':
      return "couldn't save it";
    case 'rebuild-failed':
      return "couldn't prepare it, will retry next launch";
    case 'copy-failed':
      return "couldn't copy it from the original";
  }
}
