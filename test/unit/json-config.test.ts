import { describe, expect, it } from 'vitest';
import { ConfigFormatError } from '../../src/conduit-mcp/install-types';
import {
  deletePath,
  getPath,
  parseJsonConfig,
  serializeJsonConfig,
  setPath,
} from '../../src/conduit-mcp/json-config';

const BOM = String.fromCharCode(0xfeff);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ConfigFormatError ? e.code : `not-ConfigFormatError:${String(e)}`;
  }
  return undefined;
}

describe('json-config', () => {
  it('BOM stripped; whitespace-only is {}', () => {
    expect(parseJsonConfig(`${BOM}{"a":1}`)).toEqual({ a: 1 });
    expect(parseJsonConfig('')).toEqual({});
    expect(parseJsonConfig(' \n\t ')).toEqual({});
    expect(parseJsonConfig(BOM)).toEqual({});
    expect(codeOf(() => parseJsonConfig(`${BOM}${BOM}{}`))).toBe('EJSON');
  });

  it('comments or trailing commas → EJSON', () => {
    expect(codeOf(() => parseJsonConfig('{"a":1,}'))).toBe('EJSON');
    expect(codeOf(() => parseJsonConfig('{//x\n}'))).toBe('EJSON');
    expect(codeOf(() => parseJsonConfig('{'))).toBe('EJSON');
  });

  it('array or string top level → EJSON', () => {
    expect(codeOf(() => parseJsonConfig('[]'))).toBe('EJSON');
    expect(codeOf(() => parseJsonConfig('"x"'))).toBe('EJSON');
    expect(codeOf(() => parseJsonConfig('null'))).toBe('EJSON');
  });

  it('getPath walks objects and returns undefined past a non-object', () => {
    const root = { a: { b: { c: 1 } }, s: 'x' };
    expect(getPath(root, ['a', 'b', 'c'])).toBe(1);
    expect(getPath(root, ['a', 'x'])).toBeUndefined();
    expect(getPath(root, ['s', 'length'])).toBeUndefined();
    expect(getPath(root, [])).toBe(root);
  });

  it('setPath keeps sibling order and creates parents', () => {
    const root = { first: 1, mcpServers: { a: 1, conduit: { old: true }, z: 2 }, last: 2 };
    const out = setPath(root, ['mcpServers', 'conduit'], { n: 1 });
    expect(Object.keys(out)).toEqual(['first', 'mcpServers', 'last']);
    expect(Object.keys(out.mcpServers as object)).toEqual(['a', 'conduit', 'z']);
    expect(getPath(out, ['mcpServers', 'conduit'])).toEqual({ n: 1 });

    const fresh = setPath({ x: 1 }, ['projects', '/p', 'mcpServers', 'conduit'], 5);
    expect(fresh).toEqual({ x: 1, projects: { '/p': { mcpServers: { conduit: 5 } } } });
    expect(Object.keys(fresh)).toEqual(['x', 'projects']);
  });

  it('setPath through a non-object parent → EJSON', () => {
    expect(codeOf(() => setPath({ mcpServers: [] }, ['mcpServers', 'conduit'], 1))).toBe('EJSON');
    expect(codeOf(() => setPath({ mcpServers: 'x' }, ['mcpServers', 'conduit'], 1))).toBe('EJSON');
    expect(codeOf(() => setPath({ mcpServers: null }, ['mcpServers', 'conduit'], 1))).toBe('EJSON');
  });

  it('deletePath leaves an empty parent as {}', () => {
    expect(deletePath({ mcpServers: { conduit: 1 } }, ['mcpServers', 'conduit'])).toEqual({
      mcpServers: {},
    });
    const root = { mcpServers: { a: 1 } };
    expect(deletePath(root, ['mcpServers', 'conduit'])).toEqual(root);
    expect(deletePath(root, ['nope', 'conduit'])).toEqual(root);
    expect(deletePath({ mcpServers: 'x' }, ['mcpServers', 'conduit'])).toEqual({
      mcpServers: 'x',
    });
  });

  it('neither mutates its input', () => {
    const root = { mcpServers: { conduit: { a: 1 }, other: { b: 2 } } };
    const snapshot = JSON.stringify(root);
    setPath(root, ['mcpServers', 'conduit'], 9);
    setPath(root, ['mcpServers', 'new', 'deep'], 9);
    deletePath(root, ['mcpServers', 'conduit']);
    expect(JSON.stringify(root)).toBe(snapshot);
  });

  it('serialize is 2-space with a trailing newline', () => {
    expect(serializeJsonConfig({ a: { b: 1 } })).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });
});
