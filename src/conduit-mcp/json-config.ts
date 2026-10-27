import { ConfigFormatError } from './install-types';

export type JsonObject = Record<string, unknown>;

const BOM = 0xfeff;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Strict on purpose: rewriting a JSONC file through JSON.stringify would drop the user's comments. */
export function parseJsonConfig(raw: string): JsonObject {
  const text = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw;
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigFormatError('EJSON', e instanceof Error ? e.message : String(e));
  }
  if (!isObject(parsed)) throw new ConfigFormatError('EJSON', 'top level is not an object');
  return parsed;
}

export function getPath(root: JsonObject, keys: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of keys) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Spreading keeps existing keys in place, so the user's file reads the same after our edit. */
export function setPath(root: JsonObject, keys: readonly string[], value: unknown): JsonObject {
  const [head, ...rest] = keys;
  if (head === undefined) throw new ConfigFormatError('EJSON', 'empty key path');
  if (rest.length === 0) return { ...root, [head]: value };
  const child = root[head];
  if (child !== undefined && !isObject(child)) {
    throw new ConfigFormatError('EJSON', `"${head}" is not an object`);
  }
  return { ...root, [head]: setPath(child ?? {}, rest, value) };
}

/** Parents stay, even when empty: the user may have created them. */
export function deletePath(root: JsonObject, keys: readonly string[]): JsonObject {
  const [head, ...rest] = keys;
  if (head === undefined || !Object.hasOwn(root, head)) return root;
  if (rest.length === 0) {
    const { [head]: _removed, ...kept } = root;
    return kept;
  }
  const child = root[head];
  if (!isObject(child)) return root;
  return { ...root, [head]: deletePath(child, rest) };
}

export function serializeJsonConfig(root: JsonObject): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}
