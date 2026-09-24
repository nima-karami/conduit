// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LauncherDTO } from '../../src/launchers';
import type { NewSessionPrefill, SeedContext } from '../../src/new-session-seed';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import type { AgentDefinition, Project } from '../../src/types';

const h = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  listeners: new Set<(m: HostToWebview) => void>(),
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => h.posted.push(m),
  subscribe: (cb: (m: HostToWebview) => void) => {
    h.listeners.add(cb);
    return () => h.listeners.delete(cb);
  },
}));

import { NewSessionModal } from '../../webview/components/new-session-modal';

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const agent = (id: string, label: string, command = id): AgentDefinition => ({
  id,
  label,
  command,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});

const AGENTS = [
  agent('shell:pwsh', 'PowerShell 7'),
  agent('shell:cmd', 'Command Prompt'),
  agent('cli:claude', 'claude'),
  agent('cli:codex', 'codex'),
  agent('custom:aider', 'aider'),
];
const LAUNCHERS: LauncherDTO[] = [
  { id: 'shell:pwsh', kind: 'shell', uses: 0 },
  { id: 'shell:cmd', kind: 'shell', uses: 0 },
  { id: 'cli:claude', kind: 'cli', uses: 0 },
  { id: 'cli:codex', kind: 'cli', uses: 0 },
  { id: 'custom:aider', kind: 'custom', uses: 0 },
];
const PROJECTS: Project[] = [{ id: 'p1', name: 'RMB pipeline', order: 0 }];

const ctx = (over: Partial<SeedContext> = {}): SeedContext => ({
  active: undefined,
  sessions: [],
  projects: PROJECTS,
  repos: [],
  agents: AGENTS,
  launchers: LAUNCHERS,
  defaultAgentId: '',
  ...over,
});

let host: HTMLDivElement;
let root: Root | null = null;
const onClose = vi.fn();
const onStarted = vi.fn();

async function render(prefill: NewSessionPrefill, c: SeedContext = ctx()) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NewSessionModal, { prefill, ctx: c, onClose, onStarted }));
  });
}

async function rerender(prefill: NewSessionPrefill, c: SeedContext) {
  await act(async () => {
    root?.render(createElement(NewSessionModal, { prefill, ctx: c, onClose, onStarted }));
  });
}

async function emit(m: HostToWebview) {
  await act(async () => {
    for (const l of [...h.listeners]) l(m);
  });
}

const postedOf = <T extends WebviewToHost['type']>(type: T) =>
  h.posted.filter((m): m is Extract<WebviewToHost, { type: T }> => m.type === type);
const last = <T extends WebviewToHost['type']>(type: T) => postedOf(type).at(-1);

/** Answer every probe posted so far: each path present unless listed missing. */
async function answerProbes(missing: string[] = []) {
  for (const p of postedOf('folder:probe')) {
    await emit({
      type: 'folder:probeResult',
      requestId: p.requestId,
      results: p.paths.map((path) => ({ path, exists: !missing.includes(path) })),
    });
  }
}

type PreviewReply = Extract<HostToWebview, { type: 'launch:previewResult' }>;
async function answerPreview(extra: Partial<PreviewReply> = {}) {
  const req = last('launch:preview');
  if (!req) throw new Error('no preview request');
  const flags = req.roots.flatMap((r) => ['--add-dir', r]);
  await emit({
    type: 'launch:previewResult',
    requestId: req.requestId,
    cwd: req.home,
    command: 'C:\\b\\claude.exe',
    args: flags,
    display: ['claude', ...flags].join(' '),
    skippedAddDirRoots: [],
    ...extra,
  });
}

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel);
const qa = (sel: string) => [...document.body.querySelectorAll<HTMLElement>(sel)];
const startBtn = () =>
  qa('.ns__foot button').find((b) => b.textContent === 'Start session') as HTMLButtonElement;
const names = () => qa('.ns-folder .ns-folder__name').map((n) => n.textContent);

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    (el as HTMLElement).click();
  });
}

async function key(el: Element | null | undefined, k: string) {
  if (!el) throw new Error('no key target');
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('no input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(() => {
  h.posted.length = 0;
  h.listeners.clear();
  onClose.mockReset();
  onStarted.mockReset();
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  document.body.innerHTML = '';
});

describe('NewSessionModal', () => {
  it('opening posts launchers:rescan, one folder:probe, one launch:preview', async () => {
    await render({ home: '/w/a', roots: ['/w/b'] });
    expect(postedOf('launchers:rescan')).toHaveLength(1);
    expect(postedOf('folder:probe').map((m) => m.paths)).toEqual([['/w/a', '/w/b']]);
    expect(postedOf('launch:preview')).toHaveLength(1);
    expect(last('launch:preview')).toMatchObject({ home: '/w/a', roots: ['/w/b'] });
  });

  it('row shows claude, codex, Shell with no history', async () => {
    const noCustom = ctx({ launchers: LAUNCHERS.filter((l) => l.kind !== 'custom') });
    await render({ home: '/w/a' }, noCustom);
    expect(qa('.ns-launch .ns-pill').map((p) => p.textContent)).toEqual([
      'claude',
      'codex',
      'Shell',
    ]);
    expect(q('.ns-pill[aria-checked="true"]')?.textContent).toBe('Shell');
    expect(q('.ns-pill[aria-checked="true"]')?.classList.contains('ns-pill--on')).toBe(true);
  });

  it('focus lands on the selected pill on open, not the first one', async () => {
    await render({ home: '/w/a', agentId: 'cli:codex' });
    expect(document.activeElement?.textContent).toBe('codex');
  });

  it('More opens with the header and tags, a second click closes it', async () => {
    await render({ home: '/w/a' });
    const more = q('.ns-more');
    await click(more);
    expect(more?.getAttribute('aria-expanded')).toBe('true');
    expect(q('.ns-more-menu [role="group"]')?.getAttribute('aria-label')).toBe(
      'Found on this machine',
    );
    expect(q('.ns-more__head')?.textContent).toBe('Found on this machine');
    expect(
      qa('.ns-more__item').map((r) => [
        r.querySelector('.ns-more__label')?.textContent,
        r.querySelector('.ns-more__tag')?.textContent,
      ]),
    ).toEqual([['Command Prompt', 'shell']]);
    expect(qa('.ns-more-menu [role^="menuitem"]').at(-1)?.textContent).toBe('+ Custom command…');
    await click(more);
    expect(q('.ns-more-menu')).toBeNull();
    expect(more?.getAttribute('aria-expanded')).toBe('false');
  });

  it('a More pick shows as an extra selected pill', async () => {
    await render({ home: '/w/a' });
    await click(q('.ns-more'));
    await click(qa('.ns-more__item')[0]);
    expect(q('.ns-pill[aria-checked="true"]')?.textContent).toBe('Command Prompt');
    expect(last('launch:preview')?.agentId).toBe('shell:cmd');
  });

  it('Enter in the custom Command input does not start', async () => {
    await render({ home: '/w/a' });
    await answerProbes();
    await answerPreview();
    await click(q('.ns-more'));
    await click(q('.ns-more__custom'));
    const input = q<HTMLInputElement>('input[aria-label="Command"]');
    expect(input).not.toBeNull();
    await key(input, 'Enter');
    expect(postedOf('openRepo')).toHaveLength(0);
  });

  it('custom command success selects the new launcher; an error shows inline', async () => {
    await render({ home: '/w/a' });
    await click(q('.ns-more'));
    await click(q('.ns-more__custom'));
    await type(q<HTMLInputElement>('input[aria-label="Command"]'), 'aider --x');
    await act(async () => q<HTMLFormElement>('form.ns-custom')?.requestSubmit());
    const req = last('launcher:addCustom');
    expect(req?.commandLine).toBe('aider --x');
    await emit({
      type: 'launcher:added',
      requestId: req?.requestId ?? -1,
      error: 'Can\'t find "aider" on PATH',
    });
    expect(q('.ns-custom__error')?.textContent).toBe('Can\'t find "aider" on PATH');
    await act(async () => q<HTMLFormElement>('form.ns-custom')?.requestSubmit());
    const again = last('launcher:addCustom');
    await emit({ type: 'launcher:added', requestId: again?.requestId ?? -1, id: 'custom:aider' });
    expect(q('form.ns-custom')).toBeNull();
    expect(q('.ns-pill[aria-checked="true"]')?.textContent).toBe('aider');
  });

  it('Enter on the frame starts once; a second Enter while starting posts nothing', async () => {
    await render({ home: '/w/a', roots: ['/w/b'], agentId: 'cli:claude' });
    await answerProbes();
    await answerPreview();
    const frame = q('.modal.ns');
    await key(frame, 'Enter');
    await key(frame, 'Enter');
    expect(postedOf('openRepo')).toHaveLength(1);
    expect(last('openRepo')).toMatchObject({
      path: '/w/a',
      roots: ['/w/b'],
      agentId: 'cli:claude',
    });
    expect(startBtn().disabled).toBe(true);
    const req = last('openRepo');
    await emit({
      type: 'openRepo:result',
      requestId: req?.requestId ?? -1,
      sessionId: 's1',
      droppedRoots: [],
    });
    expect(onStarted).toHaveBeenCalledWith('s1', []);
  });

  it('Enter on a pill starts; Enter on another button does not', async () => {
    await render({ home: '/w/a', agentId: 'cli:claude' });
    await answerProbes();
    await answerPreview();
    await key(q('.ns-folders__add'), 'Enter');
    expect(postedOf('openRepo')).toHaveLength(0);
    await key(q('.ns-pill[aria-checked="true"]'), 'Enter');
    expect(postedOf('openRepo')).toHaveLength(1);
  });

  it('missing home disables Start with Home folder not found', async () => {
    await render({ home: '/w/gone', roots: ['/w/b'] });
    await answerProbes(['/w/gone']);
    expect(startBtn().disabled).toBe(true);
    expect(q('.ns__reason')?.textContent).toBe('Home folder not found');
    expect(startBtn().getAttribute('aria-describedby')).toBe(q('.ns__reason')?.id);
    expect(q('.ns-folder--home .ns-folder__missing')?.textContent).toBe('Not found');
  });

  it('a missing attached root shows Not found, keeps ×, hides Make home, and is still sent', async () => {
    await render({ home: '/w/a', roots: ['/w/gone'], agentId: 'cli:claude' });
    await answerProbes(['/w/gone']);
    await answerPreview();
    const row = qa('.ns-folder')[1];
    expect(row.querySelector('.ns-folder__missing')?.textContent).toBe('Not found');
    expect(row.querySelector('.ns-folder__make')).toBeNull();
    expect(row.querySelector('.ns-folder__remove')).not.toBeNull();
    await click(startBtn());
    expect(last('openRepo')?.roots).toEqual(['/w/gone']);
  });

  it('preview skippedAddDirRoots → Start disabled, message names the folder', async () => {
    await render({ home: '/w/a', roots: ['D:\\x&y'], agentId: 'cli:claude' });
    await answerProbes();
    await answerPreview({ command: 'C:\\npm\\claude.cmd', skippedAddDirRoots: ['D:\\x&y'] });
    expect(startBtn().disabled).toBe(true);
    expect(q('.ns__reason')?.textContent).toBe(
      'claude is a .cmd shim and can\'t take "x&y" (contains &). Rename the folder or use an .exe install.',
    );
    await click(startBtn());
    await key(q('.modal.ns'), 'Enter');
    expect(postedOf('openRepo')).toHaveLength(0);
  });

  it('removing the chip → openRepo without projectId', async () => {
    const active = {
      id: 's0',
      name: 's0',
      agentId: 'shell:pwsh',
      home: '/w/a',
      roots: [],
      projectId: 'p1',
      status: 'running' as const,
      createdAt: 1,
      lastActiveAt: 1,
    };
    await render({ home: '/w/a' }, ctx({ active, sessions: [active] }));
    expect(q('.ns-chip__body')?.textContent).toBe('in RMB pipeline');
    await click(q('button[aria-label="Remove from project"]'));
    expect(q('.ns-chip--none')?.textContent).toBe('No project');
    await answerProbes();
    await answerPreview();
    await click(startBtn());
    expect(postedOf('openRepo')).toHaveLength(1);
    expect(last('openRepo')?.projectId ?? null).toBeNull();
  });

  it('picking a project → openRepo projectId', async () => {
    await render({ home: '/w/a' });
    await click(q('.ns-chip--none'));
    const item = qa('.ns-projects [role="menuitemradio"]').find(
      (b) => b.textContent === 'RMB pipeline',
    );
    await click(item);
    expect(q('.ns-chip__body')?.getAttribute('aria-label')).toBe('Project: RMB pipeline');
    await answerProbes();
    await answerPreview();
    await click(startBtn());
    expect(last('openRepo')?.projectId).toBe('p1');
  });

  it('pending project → project:create then openRepo with the new id', async () => {
    await render({ home: '/w/a' });
    await click(q('.ns-chip--none'));
    await click(q('.ns-projects__new'));
    const input = q<HTMLInputElement>('input[aria-label="Project name"]');
    await type(input, '  Fresh one ');
    await key(input, 'Enter');
    expect(q('.ns-chip--pending .ns-chip__body')?.textContent).toBe('in Fresh one');
    await answerProbes();
    await answerPreview();
    await click(startBtn());
    expect(postedOf('openRepo')).toHaveLength(0);
    const create = last('project:create');
    expect(create?.name).toBe('Fresh one');
    await emit({ type: 'project:created', requestId: create?.requestId ?? -1, id: 'p9' });
    expect(last('openRepo')?.projectId).toBe('p9');
  });

  it('a failed project:create marks the chip and posts no openRepo', async () => {
    await render({ home: '/w/a' });
    await click(q('.ns-chip--none'));
    await click(q('.ns-projects__new'));
    const input = q<HTMLInputElement>('input[aria-label="Project name"]');
    await type(input, 'Fresh');
    await key(input, 'Enter');
    await answerProbes();
    await answerPreview();
    await click(startBtn());
    const create = last('project:create');
    await emit({
      type: 'project:opResult',
      requestId: create?.requestId ?? -1,
      ok: false,
      reason: 'store-unavailable',
    });
    expect(q('.ns-chip__error')?.textContent).toBe("Couldn't create project");
    expect(postedOf('openRepo')).toHaveLength(0);
  });

  it("openRepo:result error keeps the dialog open with Couldn't start session: home folder not found", async () => {
    await render({ home: '/w/a', agentId: 'cli:claude' });
    await answerProbes();
    await answerPreview();
    await click(startBtn());
    const req = last('openRepo');
    await emit({
      type: 'openRepo:result',
      requestId: req?.requestId ?? -1,
      droppedRoots: [],
      error: 'home-missing',
    });
    expect(onStarted).not.toHaveBeenCalled();
    expect(q('.ns__error')?.textContent).toBe("Couldn't start session: home folder not found");
    expect(startBtn().disabled).toBe(false);
  });

  it('stale preview reply ignored', async () => {
    await render({ home: '/w/a', roots: ['/w/b'], agentId: 'cli:claude' });
    const first = last('launch:preview');
    await answerProbes();
    await click(q('button[aria-label="Make b home"]'));
    const second = last('launch:preview');
    expect(second?.requestId).not.toBe(first?.requestId);
    await emit({
      type: 'launch:previewResult',
      requestId: second?.requestId ?? -1,
      cwd: '/w/b',
      display: 'claude --add-dir /w/a',
      skippedAddDirRoots: [],
    });
    await emit({
      type: 'launch:previewResult',
      requestId: first?.requestId ?? -1,
      cwd: '/w/a',
      display: 'claude --add-dir /w/b',
      skippedAddDirRoots: [],
    });
    expect(q('.ns-preview')?.textContent).toBe('/w/b> claude --add-dir /w/a');
    expect(q('.ns-preview .ns-preview__flag')?.textContent).toBe('--add-dir');
  });

  it('Make home changes the preview request home', async () => {
    await render({ home: '/w/a', roots: ['/w/b', '/w/c'], agentId: 'cli:claude' });
    await answerProbes();
    await click(q('button[aria-label="Make b home"]'));
    expect(last('launch:preview')).toMatchObject({ home: '/w/b', roots: ['/w/a', '/w/c'] });
    expect(names()).toEqual(['b', 'a', 'c']);
    expect(q('.ns-folder--home .ns-folder__name')?.textContent).toBe('b');
  });

  it('Browse… posts folder:pick and a picked folder is added and probed', async () => {
    await render({ home: '/w/a' });
    await click(q('.ns-folders__add'));
    const browse = qa('.ns-addmenu [role="menuitem"]').find((b) => b.textContent === 'Browse…');
    await click(browse);
    const pick = last('folder:pick');
    await emit({ type: 'folder:picked', requestId: pick?.requestId ?? -1, path: '/w/new' });
    expect(names()).toEqual(['a', 'new']);
    expect(last('folder:probe')?.paths).toEqual(['/w/new']);
    expect(q('.ns__live')?.textContent).toBe('Added new');
  });

  it('the Add folder menu lists recents not already listed, else No recent folders', async () => {
    const repos = [
      { path: '/w/a', name: 'a', lastOpened: 3 },
      { path: '/w/r1', name: 'r1', lastOpened: 2 },
    ];
    await render({ home: '/w/a' }, ctx({ repos }));
    await click(q('.ns-folders__add'));
    expect(qa('.ns-addmenu__name').map((n) => n.textContent)).toEqual(['r1']);
    await click(qa('.ns-addmenu__item')[0]);
    expect(names()).toEqual(['a', 'r1']);
    await click(q('.ns-folders__add'));
    expect(q('.ns-addmenu__empty')?.textContent).toBe('No recent folders');
  });

  it('a project deleted while open falls back to standalone', async () => {
    await render({ home: '/w/a', projectId: 'p1' });
    expect(q('.ns-chip__body')?.textContent).toBe('in RMB pipeline');
    await rerender({ home: '/w/a', projectId: 'p1' }, ctx({ projects: [] }));
    expect(q('.ns-chip--none')).not.toBeNull();
  });

  it('the board card subtitle names the card', async () => {
    await render({ home: '/w/a', cardId: 'c1', cardTitle: 'Move RMB to CI' });
    expect(q('.ns .modal__sub')?.textContent).toBe('Start a session for "Move RMB to CI"');
  });
});
