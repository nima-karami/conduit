import { describe, expect, it } from 'vitest';
import type { TsconfigDTO } from '../../src/tsconfig-map';
import { CompilerOptionsRoot } from '../../webview/ts-options-root';

const cfg = (n: string) => ({ compilerOptions: { target: n } }) as unknown as TsconfigDTO;

function setup() {
  const applied: (TsconfigDTO | undefined)[] = [];
  const root = new CompilerOptionsRoot((t) => applied.push(t));
  return { root, applied };
}

describe('CompilerOptionsRoot', () => {
  it('attached-folder chunk does not apply', () => {
    const { root, applied } = setup();
    root.setRoot('/w/home');
    root.noteChunk('/w/attached', cfg('att'));
    expect(applied).toEqual([]);
  });

  it('home chunk applies', () => {
    const { root, applied } = setup();
    root.setRoot('C:\\W\\Home');
    root.noteChunk('c:/w/home', cfg('home'));
    expect(applied).toEqual([cfg('home')]);
  });

  it('setRoot to a cached root applies its tsconfig (session switch)', () => {
    const { root, applied } = setup();
    root.setRoot('/w/a');
    root.noteChunk('/w/a', cfg('a'));
    root.noteChunk('/w/b', cfg('b'));
    root.setRoot('/w/b');
    root.setRoot('/w/a');
    expect(applied).toEqual([cfg('a'), cfg('b'), cfg('a')]);
  });

  it('setRoot to an uncached root applies nothing until its chunk arrives', () => {
    const { root, applied } = setup();
    root.setRoot('/w/new');
    expect(applied).toEqual([]);
    root.noteChunk('/w/new', cfg('new'));
    expect(applied).toEqual([cfg('new')]);
  });

  it('Make home: setRoot(old attached) applies its cached tsconfig', () => {
    const { root, applied } = setup();
    root.setRoot('/w/rmb');
    root.noteChunk('/w/rmb', cfg('rmb'));
    root.noteChunk('/w/ci', cfg('ci'));
    root.setRoot('/w/ci');
    expect(applied).toEqual([cfg('rmb'), cfg('ci')]);
  });

  it('undefined tsconfig is cached as known and applied as defaults', () => {
    const { root, applied } = setup();
    root.noteChunk('/w/plain', undefined);
    root.setRoot('/w/plain');
    expect(applied).toEqual([undefined]);
    expect(applied).toHaveLength(1);
  });

  it('setRoot(undefined) applies nothing', () => {
    const { root, applied } = setup();
    root.noteChunk('/w/a', cfg('a'));
    root.setRoot(undefined);
    root.noteChunk('/w/a', cfg('a2'));
    expect(applied).toEqual([]);
  });
});
