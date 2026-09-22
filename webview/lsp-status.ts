// What the renderer knows about language servers: the host's server statuses and which languages
// the host's registry serves. Nothing here names a language — "does X have a server" is always
// answered from the host's list (spec docs/specs/2026-09-22-language-server-go.md §3.1).
import { useSyncExternalStore } from 'react';
import type { LspDocState, LspLanguageInfo, LspServerStatus } from '../src/lsp-protocol';

let servers: readonly LspServerStatus[] = [];
let languages: readonly LspLanguageInfo[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** `stopped` removes the entry: a stopped server is one the host no longer holds. */
export function applyLspStatus(s: LspServerStatus): void {
  const rest = servers.filter((x) => x.serverKey !== s.serverKey);
  servers = s.state === 'stopped' ? rest : [...rest, s];
  notify();
}

export function seedLspState(snapshot: {
  servers: readonly LspServerStatus[];
  languages: readonly LspLanguageInfo[];
}): void {
  servers = snapshot.servers.filter((s) => s.state !== 'stopped');
  languages = snapshot.languages;
  notify();
}

export function lspStateForKey(serverKey: string | null): LspDocState | null {
  if (serverKey === null) return null;
  return servers.find((s) => s.serverKey === serverKey)?.state ?? null;
}

export function lspLanguage(languageId: string): LspLanguageInfo | null {
  return languages.find((l) => l.languageId === languageId) ?? null;
}

export function hasLanguageServer(languageId: string): boolean {
  return lspLanguage(languageId) !== null;
}

export function subscribeLspStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useLspStatuses(): readonly LspServerStatus[] {
  return useSyncExternalStore(subscribeLspStatus, () => servers);
}

export function useLspLanguages(): readonly LspLanguageInfo[] {
  return useSyncExternalStore(subscribeLspStatus, () => languages);
}

/** Languages with a server entry the host still holds — running, absent or crashed alike: the
 *  palette's restart is the way out of every one of those (spec §2.2 "Manual recovery"). */
export function restartableLanguages(
  statuses: readonly LspServerStatus[],
  langs: readonly LspLanguageInfo[],
): LspLanguageInfo[] {
  return langs.filter((l) =>
    statuses.some((s) => s.languageId === l.languageId && s.state !== 'stopped'),
  );
}
