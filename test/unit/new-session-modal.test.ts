// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RepoDTO } from '../../src/protocol';
import type { AgentDefinition } from '../../src/types';
import { NewSessionModal } from '../../webview/components/new-session-modal';
import { SettingsProvider } from '../../webview/settings';

/**
 * "Browse…" used to be the last row INSIDE `.repolist`, so a user with a few recent repos had
 * to scroll to the bottom of the list to reach it every time. It is pinned above the scrolling
 * list now — a structural property: nothing about the row's own styling says whether it can be
 * scrolled away.
 */

const AGENTS: AgentDefinition[] = [
  {
    id: 'shell:cmd',
    label: 'Command Prompt',
    command: 'cmd.exe',
    args: [],
    icon: 'terminal',
    color: 'terminal.ansiBlue',
    cwdStrategy: 'workspaceFolder',
  },
];

const repos = (n: number): RepoDTO[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `/tmp/repo-${i}`,
    name: `repo-${i}`,
    lastOpened: n - i,
  }));

let host: HTMLDivElement;
let root: Root | null = null;

async function render(list: RepoDTO[]) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        SettingsProvider,
        null,
        createElement(NewSessionModal, {
          repos: list,
          agents: AGENTS,
          onClose: () => {},
          onOpen: () => {},
          onBrowse: () => {},
        }),
      ),
    );
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
});

describe('new-session modal — pinned Browse row', () => {
  it('renders Browse outside the scrolling list and before the recents', async () => {
    await render(repos(12));

    const b = host.querySelector<HTMLButtonElement>('.repo--browse');
    const first = host.querySelector('.repolist .repo');
    if (!b || !first) throw new Error('expected a Browse row and at least one recent row');

    expect(b.textContent).toContain('Browse');
    expect(host.querySelector('.repolist .repo--browse')).toBeNull();
    // Tab order follows DOM order here (nothing carries a tabindex), so this pins keyboard
    // reachability along with the visual position.
    expect(b.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows Browse alone, with no empty list to divide from, when there are no recents', async () => {
    await render([]);

    expect(host.querySelector('.repo--browse')).not.toBeNull();
    expect(host.querySelector('.repolist')).toBeNull();
  });

  it('hangs the divider off the list, so it goes away with it', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
    const list = /\n\.repolist \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const pinned = /\n\.repobrowse \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(list).toMatch(/border-top:/);
    expect(pinned).not.toMatch(/border-bottom:/);
  });
});
