import type { GroupIndex } from './doc-groups';

// see split-editor spec §3.2: one entry per mounted viewer of a path, not one per path.
export interface PathRegistry<T> {
  register(path: string, value: T, group: GroupIndex): () => void;
  get(path: string, prefer?: GroupIndex): T | undefined;
  entries(path: string): readonly { value: T; group: GroupIndex }[];
}

export function createPathRegistry<T>(
  normalize: (path: string) => string = (p) => p,
): PathRegistry<T> {
  const byPath = new Map<string, { value: T; group: GroupIndex }[]>();

  return {
    register(path, value, group) {
      const key = normalize(path);
      const entry = { value, group };
      const list = byPath.get(key);
      if (list) list.push(entry);
      else byPath.set(key, [entry]);
      return () => {
        const current = byPath.get(key);
        const at = current ? current.indexOf(entry) : -1;
        if (!current || at < 0) return;
        current.splice(at, 1);
        if (current.length === 0) byPath.delete(key);
      };
    },
    get(path, prefer) {
      const list = byPath.get(normalize(path));
      if (!list || list.length === 0) return undefined;
      if (prefer !== undefined) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].group === prefer) return list[i].value;
        }
      }
      return list[list.length - 1].value;
    },
    entries(path) {
      return (byPath.get(normalize(path)) ?? []).map(({ value, group }) => ({ value, group }));
    },
  };
}
