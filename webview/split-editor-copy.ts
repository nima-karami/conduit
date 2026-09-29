import type { GroupIndex } from './doc-groups';

export const SPLIT_COPY = {
  splitRight: 'Split Right',
  splitButton: 'Split editor right',
  focusLeft: 'Focus Left Editor Group',
  focusRight: 'Focus Right Editor Group',
  groupLabel: (g: GroupIndex, active: boolean) =>
    `${g === 1 ? 'Left' : 'Right'} editor group${active ? ', active' : ''}`,
  tablistLabel: (g: GroupIndex) => `${g === 1 ? 'Left' : 'Right'} editor group tabs`,
  divider: 'Resize editor groups',
  capReached: 'Only two editor groups are supported.',
  terminalCantSplit: "The terminal can't be split into an editor group",
  splitOpened: (title: string) => `Split editor: ${title} opened in right group`,
} as const;
