import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspLanguageInfo, LspServerStatus } from '../../src/lsp-protocol';
import {
  applyLspStatus,
  hasLanguageServer,
  lspLanguage,
  lspStateForKey,
  restartableLanguages,
  seedLspState,
  servedLanguageIds,
  subscribeLspStatus,
  trustLanguageFor,
} from '../../webview/lsp-status';

const GO: LspLanguageInfo = {
  languageId: 'go',
  languageIds: ['go'],
  displayName: 'Go',
  binary: 'gopls',
  installHint: 'go install golang.org/x/tools/gopls@latest',
  moduleMarker: 'go.mod',
};
const CLANGD: LspLanguageInfo = {
  languageId: 'cpp',
  languageIds: ['cpp', 'c'],
  displayName: 'C/C++',
  binary: 'clangd',
  installHint: 'install LLVM',
  moduleMarker: 'CMakeLists.txt',
};
const status = (over: Partial<LspServerStatus> = {}): LspServerStatus => ({
  serverKey: 'go:/w/m',
  languageId: 'go',
  root: '/w/m',
  state: 'ready',
  pid: 1,
  ...over,
});

beforeEach(() => {
  seedLspState({ servers: [], languages: [] });
});

describe('lsp-status', () => {
  it('stopped removes the entry', () => {
    applyLspStatus(status());
    expect(lspStateForKey('go:/w/m')).toBe('ready');
    applyLspStatus(status({ state: 'stopped' }));
    expect(lspStateForKey('go:/w/m')).toBeNull();
  });

  it('later status replaces earlier', () => {
    const cb = vi.fn();
    const off = subscribeLspStatus(cb);
    applyLspStatus(status({ state: 'starting' }));
    applyLspStatus(status({ state: 'loading' }));
    expect(lspStateForKey('go:/w/m')).toBe('loading');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
  });

  it('hasLanguageServer reflects the seeded languages only (go true after seed, false before; rust false)', () => {
    expect(hasLanguageServer('go')).toBe(false);
    seedLspState({ servers: [], languages: [GO] });
    expect(hasLanguageServer('go')).toBe(true);
    expect(lspLanguage('go')).toEqual(GO);
    expect(hasLanguageServer('rust')).toBe(false);
    expect(hasLanguageServer('gomod')).toBe(false);
  });

  it('restartableLanguages lists a language with an absent or crashed entry, not one with none', () => {
    const rust = { ...GO, languageId: 'rust', languageIds: ['rust'], displayName: 'Rust' };
    expect(restartableLanguages([status({ state: 'absent' })], [GO, rust])).toEqual([GO]);
    expect(restartableLanguages([status({ state: 'crashed' })], [GO])).toEqual([GO]);
    expect(restartableLanguages([], [GO, rust])).toEqual([]);
    expect(restartableLanguages([status({ state: 'stopped' })], [GO])).toEqual([]);
  });

  it('lspLanguage matches any of a server’s ids', () => {
    seedLspState({ servers: [], languages: [GO, CLANGD] });
    expect(lspLanguage('c')).toBe(CLANGD);
    expect(lspLanguage('cpp')).toBe(CLANGD);
    expect(hasLanguageServer('c')).toBe(true);
  });

  it('servedLanguageIds is the union of every server’s ids', () => {
    expect(servedLanguageIds([GO, CLANGD])).toEqual(new Set(['go', 'cpp', 'c']));
    expect(servedLanguageIds([])).toEqual(new Set());
  });

  it('lspStateForKey(null) is null', () => {
    applyLspStatus(status());
    expect(lspStateForKey(null)).toBeNull();
    expect(lspStateForKey('go:/other')).toBeNull();
  });
});

describe('trustLanguageFor', () => {
  const CS: LspLanguageInfo = {
    ...GO,
    languageId: 'csharp',
    languageIds: ['csharp'],
    displayName: 'C#',
    binary: 'csharp-ls',
  };

  it("names the active file's language when it is served", () => {
    expect(trustLanguageFor('csharp', [GO, CS])).toBe(CS);
    expect(trustLanguageFor('go', [GO, CS])).toBe(GO);
    expect(trustLanguageFor('c', [GO, CLANGD])).toBe(CLANGD);
  });

  it('falls back to the first served language', () => {
    expect(trustLanguageFor('markdown', [CS, GO])).toBe(CS);
    expect(trustLanguageFor(null, [GO, CS])).toBe(GO);
    expect(trustLanguageFor('go', [])).toBeUndefined();
  });
});
