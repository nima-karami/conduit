// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MonitorSession } from '../../src/contracts/link-protocol';

import { RightPane } from '../../webview/components/right-pane';
import type { RemoteSessionRow } from '../../webview/remote-sessions';
import { SettingsProvider } from '../../webview/settings';
import {
  type WorkbenchChromeContextValue,
  WorkbenchChromeProvider,
} from '../../webview/workbench-chrome-state';

const noop = () => {};
const changesChrome: WorkbenchChromeContextValue = {
  rightOpen: true,
  rightTab: 'changes',
  togglePanel: noop,
  openPanel: noop,
  status: {
    branch: null,
    worktree: null,
    liveCount: 0,
    attentionCount: 0,
    firstAttention: null,
    showCommandHint: false,
    waitingUntil: null,
  },
  commandHint: '',
  presence: null,
  setAway: () => {},
  focusAttention: noop,
  update: { status: null, dismissed: false, dismiss: noop, reveal: noop, openNotes: noop },
};

const SESSION: MonitorSession = {
  sessionId: 'S1',
  handle: 'claude-3',
  label: 'Claude',
  agent: 'cli:claude',
  presence: 'busy',
  messaging: 'connected',
  messageable: true,
  notices: 'typed',
  home: '/home/me/p',
  roots: ['/home/me/p'],
  attention: { attentionReason: 'blocked', completions: 0 },
  completions: 0,
  limit: null,
  status: 'running',
};

const REMOTE: RemoteSessionRow = {
  key: { machineId: 'M1', sessionId: 'S1' },
  id: 'remote:M1:S1',
  machineName: 'box',
  machineState: 'up',
  session: SESSION,
  parentSessionId: null,
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  host = null;
});

async function render(remote: RemoteSessionRow | null) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        SettingsProvider,
        null,
        createElement(
          WorkbenchChromeProvider,
          { value: changesChrome },
          createElement(RightPane, {
            sessionId: 's1',
            activeTarget: null,
            sections: [],
            rowChanges: new Map(),
            osDropSeam: false,
            reviewRepoChanges: undefined,
            // A local session with no repo would show the local panel's own empty state.
            changesModel: { kind: 'no-session' },
            onOpenFile: noop,
            onOpenMatch: noop,
            setMenu: noop,
            revealPath: noop,
            openExternalApp: noop,
            openWithChooser: noop,
            openAsSession: noop,
            copyToClipboard: noop,
            onDeleteFiles: noop,
            onFileRenamed: noop,
            onReviewScope: noop,
            reviewMode: false,
            reviewTitle: 'Review changes',
            onReview: noop,
            onRetryRepo: noop,
            onSetView: noop,
            onRefresh: noop,
            onOpenDiff: noop,
            onRepoContext: noop,
            onRepoHeadContextMenu: noop,
            onChangeContextMenu: noop,
            onAction: async () => {},
            onPickActiveRepo: noop,
            renderChip: () => null,
            remote,
            mcp: {
              state: null,
              getThread: async () => null,
              send: async () => null,
              getAttachment: async () => null,
              markRead: noop,
              allowMore: noop,
              pause: noop,
              retry: noop,
              grantLifecycle: async () => null,
              getOwnerPermissions: async () => null,
              getActivity: async () => null,
              linkCodexThread: async () => ({ status: 'unavailable' as const }),
              codexPostureQuery: async () => ({ status: 'unavailable' as const }),
              setAssignment: async () => true,
              revokeGrant: async () => true,
              allowOnce: async () => true,
              reviewLocalPolicy: async () => null,
              saveAssignment: async () => ({ ok: true as const }),
              saveProfile: async () => ({ ok: true as const }),
              deleteProfile: async () => ({ ok: true as const }),
              retryPolicy: async () => ({ ok: true as const }),
              setToolPolicy: async () => true,
              setPointPolicy: async () => true,
              remotePolicy: async () => ({ ok: true as const }),
              remoteEdit: async () => ({ ok: true as const }),
              answerPermission: async () => ({ ok: true as const }),
              answerRequest: async () => ({
                ok: false as const,
                reason: 'not_found' as const,
                message: '',
                request: null,
              }),
              setAway: () => {},
            },
            sessions: [],
            spaceNames: new Map(),
            sidebarSelection: { kind: 'all' },
            sidebarSpaceName: null,
            selectedAgentHandle: null,
            messagesFilterHandle: null,
            onMessagesFilterHandleChange: noop,
            onOpenSettings: noop,
          }),
        ),
      ),
    );
  });
}

describe('right pane Changes tab for a remote session', () => {
  it('a remote row renders RemoteChangesView, not the local Changes view', async () => {
    await render(REMOTE);
    expect(host?.querySelector('.remote-changes')).not.toBeNull();
    expect(host?.textContent).not.toContain('Start a session to see its changes here.');
  });

  it('without a remote row the local Changes view stays', async () => {
    await render(null);
    expect(host?.querySelector('.remote-changes')).toBeNull();
    expect(host?.textContent).toContain('Start a session to see its changes here.');
  });
});
