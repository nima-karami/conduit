import type { FsShim } from '../../src/module-paths';

/** In-memory tree. Keys are forward-slash absolute paths; a value of `null` marks a directory. */
export function memFs(tree: Record<string, string | null>): FsShim {
  const dirs = new Set<string>();
  for (const p of Object.keys(tree)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    if (tree[p] === null) dirs.add(p);
  }
  return {
    readText: (p) => (typeof tree[p] === 'string' ? tree[p] : null),
    isFile: (p) => typeof tree[p] === 'string',
    isDirectory: (p) => dirs.has(p),
    realpath: (p) => p,
  };
}
