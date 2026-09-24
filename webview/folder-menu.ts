import type { FolderSectionModel } from '../src/session-sections';
import type { MenuItem } from './components/context-menu';

const STR = {
  makeHome: 'Make home',
  notFound: 'Folder not found',
  reveal: 'Reveal in Explorer',
  copyPath: 'Copy path',
  remove: 'Remove from session',
};

export interface FolderMenuHandlers {
  makeHome(): void;
  reveal(): void;
  copyPath(): void;
  remove(): void;
}

/** The `···` menu of one Files-tab folder bar (mf-files spec §2.4). Home is never removable. */
export function buildFolderMenuItems(
  section: FolderSectionModel,
  h: FolderMenuHandlers,
): MenuItem[] {
  const common: MenuItem[] = [
    { label: STR.reveal, onClick: h.reveal },
    { label: STR.copyPath, onClick: h.copyPath },
  ];
  if (section.kind === 'home') return common;
  return [
    {
      label: STR.makeHome,
      onClick: h.makeHome,
      ...(section.missing ? { disabled: true, title: STR.notFound } : {}),
    },
    ...common,
    { label: STR.remove, onClick: h.remove, danger: true, separatorBefore: true },
  ];
}
