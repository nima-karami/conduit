import { createContext, useContext } from 'react';
import type { AttentionEntry } from '../src/attention';
import type { RightPaneTab } from '../src/settings';
import type { StatusBarModel } from '../src/status-bar-model';
import type { UpdateStatus } from './components/update-card';

/**
 * The header toggles, right panel, footer and update toast read one App-owned view state
 * (docs/plans/2026-11-02-sidebar-agent-tree.plan.md "Renderer context signatures").
 */
export interface WorkbenchChromeContextValue {
  rightOpen: boolean;
  /** The effective view, transient imperative ones included; drives header and panel alike. */
  rightTab: RightPaneTab;
  /** An explicit header click: the active view closes the panel, another opens it and is remembered. */
  togglePanel(tab: RightPaneTab): void;
  openPanel(tab: RightPaneTab, remember: boolean): void;
  status: StatusBarModel;
  /** The bound openCommands combo for display; '' when unbound. */
  commandHint: string;
  focusAttention(entry: AttentionEntry): void;
  update: {
    status: UpdateStatus | null;
    dismissed: boolean;
    dismiss(): void;
    reveal(): void;
    openNotes(): void;
    notesOpen?: boolean;
    installedToast?: { version: string; open(): void; dismiss(): void };
  };
}

const WorkbenchChromeContext = createContext<WorkbenchChromeContextValue | null>(null);
export const WorkbenchChromeProvider = WorkbenchChromeContext.Provider;

export function useWorkbenchChromeState(): WorkbenchChromeContextValue {
  const value = useContext(WorkbenchChromeContext);
  if (!value) throw new Error('useWorkbenchChromeState needs a WorkbenchChromeProvider');
  return value;
}
