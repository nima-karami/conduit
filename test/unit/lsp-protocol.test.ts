import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type LspMessage,
  type LspResult,
  parseLspEnvelope,
  parseLspMessage,
} from '../../src/lsp-protocol';

const REQ = {
  type: 'lsp:request',
  requestId: 'r1',
  path: 'C:\\m\\main.go',
  version: 3,
  op: 'definition',
  line: 4,
  character: 2,
};

describe('parseLspMessage', () => {
  it('accepts each well-formed message type', () => {
    const msgs = [
      { type: 'lsp:open', path: '/m/a.go', languageId: 'go', version: 1, text: 'package a' },
      { type: 'lsp:change', path: '/m/a.go', version: 2, text: '' },
      { type: 'lsp:close', path: '/m/a.go' },
      REQ,
      { type: 'lsp:cancel', requestId: 'r1' },
      { type: 'lsp:statusSnapshot' },
      { type: 'lsp:restart', languageId: 'go' },
    ];
    for (const m of msgs) expect(parseLspMessage(m)).toEqual(m);
  });

  it('copies only known fields', () => {
    expect(parseLspMessage({ type: 'lsp:close', path: '/a.go', extra: 1 })).toEqual({
      type: 'lsp:close',
      path: '/a.go',
    });
  });

  it('rejects a relative path', () => {
    expect(parseLspMessage({ type: 'lsp:close', path: 'a.go' })).toBeNull();
    expect(parseLspMessage({ type: 'lsp:close', path: 'C:a.go' })).toBeNull();
    expect(parseLspMessage({ type: 'lsp:close', path: '' })).toBeNull();
  });

  it('accepts drive, POSIX and UNC absolute paths', () => {
    for (const path of ['C:\\x\\a.go', 'c:/x/a.go', '/x/a.go', '\\\\srv\\share\\a.go']) {
      expect(parseLspMessage({ type: 'lsp:close', path })).not.toBeNull();
    }
  });

  it('rejects negative or fractional line/character', () => {
    expect(parseLspMessage({ ...REQ, line: -1 })).toBeNull();
    expect(parseLspMessage({ ...REQ, character: 1.5 })).toBeNull();
    expect(parseLspMessage({ ...REQ, version: '3' })).toBeNull();
  });

  it('rejects an unknown op or type', () => {
    expect(parseLspMessage({ ...REQ, op: 'rename' })).toBeNull();
    expect(parseLspMessage({ ...REQ, op: 'toString' })).toBeNull();
    expect(parseLspMessage({ type: 'lsp:exec' })).toBeNull();
    expect(parseLspMessage(null)).toBeNull();
    expect(parseLspMessage([REQ])).toBeNull();
  });

  it('rejects requestId over 64', () => {
    expect(parseLspMessage({ ...REQ, requestId: 'x'.repeat(65) })).toBeNull();
    expect(parseLspMessage({ ...REQ, requestId: 'x'.repeat(64) })).not.toBeNull();
    expect(parseLspMessage({ type: 'lsp:cancel', requestId: '' })).toBeNull();
  });

  it('rejects a languageId that is empty or over 32', () => {
    const open = { type: 'lsp:open', path: '/a.go', version: 1, text: '' };
    expect(parseLspMessage({ ...open, languageId: '' })).toBeNull();
    expect(parseLspMessage({ ...open, languageId: 'x'.repeat(33) })).toBeNull();
  });
});

describe('LspCalls typing', () => {
  it('pairs each message type with its reply', () => {
    expectTypeOf<LspResult<'lsp:close'>>().toEqualTypeOf<{ ok: boolean }>();
    expectTypeOf<{ type: 'lsp:statusSnapshot' }>().toExtend<LspMessage<'lsp:statusSnapshot'>>();
  });
});

describe('parseLspEnvelope', () => {
  it('envelope needs a non-empty epoch ≤ 64 and a valid msg', () => {
    expect(parseLspEnvelope({ epoch: 'e', msg: REQ })).toEqual({ epoch: 'e', msg: REQ });
    expect(parseLspEnvelope({ epoch: '', msg: REQ })).toBeNull();
    expect(parseLspEnvelope({ epoch: 'x'.repeat(65), msg: REQ })).toBeNull();
    expect(parseLspEnvelope({ epoch: 'e', msg: { type: 'x' } })).toBeNull();
    expect(parseLspEnvelope(REQ)).toBeNull();
  });
});

describe('path confinement at the boundary (review #1)', () => {
  it('rejects a path with . or .. segments, in every spelling', () => {
    for (const path of [
      'G:\\ws\\..\\..\\other\\x.go',
      'G:/ws/../other/x.go',
      '/w/ws/../../etc/x.go',
      '/w/./x.go',
      '\\\\srv\\share\\..\\x.go',
      'G:\\ws\\..',
    ]) {
      expect(parseLspMessage({ type: 'lsp:close', path }), path).toBeNull();
      expect(
        parseLspMessage({ type: 'lsp:open', path, languageId: 'go', version: 1, text: '' }),
        path,
      ).toBeNull();
    }
  });

  it('still accepts names that merely contain dots', () => {
    for (const path of ['G:\\ws\\..x\\a..go', '/w/.hidden/x.go', '/w/a.b/.../x.go']) {
      expect(parseLspMessage({ type: 'lsp:close', path }), path).not.toBeNull();
    }
  });
});
