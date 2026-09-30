import { createContext, useContext } from 'react';
import type { GroupIndex } from './doc-groups';

export const EditorGroupContext = createContext<GroupIndex>(1);

export function useEditorGroup(): GroupIndex {
  return useContext(EditorGroupContext);
}

// see split-editor plan P5: group 1's keys stay byte-identical to the pre-split ones.
export function tabStateKey(docId: string, group: GroupIndex): string {
  return group === 1 ? docId : `g2:${docId}`;
}
