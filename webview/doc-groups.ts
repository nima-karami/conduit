import type { DocKind, DocsState, OpenDoc } from './docs';

export type GroupIndex = 1 | 2;
export interface Tab {
  id: string;
  preview?: true;
}
/** `active === null` is the Terminal, legal in group 1 only (I5). */
export interface EditorGroup {
  tabs: readonly Tab[];
  active: string | null;
}
export interface SessionLayout {
  groups: readonly [EditorGroup] | readonly [EditorGroup, EditorGroup];
  activeGroup: GroupIndex;
}
export const EMPTY_LAYOUT: SessionLayout = { groups: [{ tabs: [], active: null }], activeGroup: 1 };

/** How Split Right / a cross-group open treats a kind (spec §2.3). */
export type SplitBehavior = 'duplicate' | 'move';
export function splitBehavior(kind: DocKind): SplitBehavior {
  return kind === 'web' || kind === 'review' || kind === 'git-history' ? 'move' : 'duplicate';
}

export function layoutOf(state: DocsState, sessionId: string): SessionLayout {
  return state.layouts[sessionId] ?? EMPTY_LAYOUT;
}

const groupOf = (state: DocsState, sessionId: string, group: GroupIndex): EditorGroup | undefined =>
  layoutOf(state, sessionId).groups[group - 1];

export function groupDocs(state: DocsState, sessionId: string, group: GroupIndex): OpenDoc[] {
  const g = groupOf(state, sessionId, group);
  if (!g) return [];
  const byId = new Map(state.docs.map((d) => [d.id, d]));
  return g.tabs.flatMap((t) => {
    const doc = byId.get(t.id);
    return doc ? [doc] : [];
  });
}

export function groupActive(state: DocsState, sessionId: string, group: GroupIndex): string | null {
  return groupOf(state, sessionId, group)?.active ?? null;
}

export function tabPreview(
  state: DocsState,
  sessionId: string,
  group: GroupIndex,
  id: string,
): boolean {
  return groupOf(state, sessionId, group)?.tabs.some((t) => t.id === id && t.preview) ?? false;
}

export function previewIdsOf(
  state: DocsState,
  sessionId: string,
  group: GroupIndex,
): ReadonlySet<string> {
  const g = groupOf(state, sessionId, group);
  return new Set(g ? g.tabs.filter((t) => t.preview).map((t) => t.id) : []);
}

export function openTargetGroup(state: DocsState, sessionId: string): GroupIndex {
  const layout = layoutOf(state, sessionId);
  if (layout.groups.length === 1) return 1;
  if (layout.activeGroup === 1 && layout.groups[0].active === null) return 2;
  return layout.activeGroup;
}

export function resolveActivateGroup(
  state: DocsState,
  sessionId: string,
  id: string | null,
): GroupIndex {
  if (id === null) return 1;
  const layout = layoutOf(state, sessionId);
  const holds = (g: GroupIndex) => layout.groups[g - 1]?.tabs.some((t) => t.id === id) ?? false;
  if (holds(layout.activeGroup)) return layout.activeGroup;
  if (holds(1)) return 1;
  if (holds(2)) return 2;
  return layout.activeGroup;
}

/** Every preview tab, in any session and either group, whose doc is a file/diff on a dirty path (P8). */
export function dirtyPreviewTabs(
  state: DocsState,
  dirty: ReadonlySet<string>,
): readonly { id: string; group: GroupIndex }[] {
  const byId = new Map(state.docs.map((d) => [d.id, d]));
  const out: { id: string; group: GroupIndex }[] = [];
  for (const layout of Object.values(state.layouts)) {
    layout.groups.forEach((g, i) => {
      for (const t of g.tabs) {
        if (!t.preview) continue;
        const doc = byId.get(t.id);
        if (doc && (doc.kind === 'file' || doc.kind === 'diff') && dirty.has(doc.path)) {
          out.push({ id: t.id, group: i === 0 ? 1 : 2 });
        }
      }
    });
  }
  return out;
}
