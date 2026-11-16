// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnswerInput,
  RequestAnswerResult,
  RequestView,
} from '../../src/conduit-mcp/request-types';
import {
  RequestTemplate,
  type RequestTemplateProps,
  SWAP_GUARD_MS,
} from '../../webview/components/request-template';
import { setDraft } from '../../webview/request-drafts';
import { REQ_STR } from '../../webview/request-strings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const clock = { t: 1_000_000 };
let seq = 0;
let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  clock.t = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.t);
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}

function view(over: Partial<RequestView> = {}): RequestView {
  return {
    id: 'base',
    origin: 'm1',
    source: 'agent',
    kind: 'choose',
    requester: 'claude-7',
    session: 's1',
    space: null,
    lead: null,
    machine: 'this-machine',
    title: 'Drop rules for nested rows?',
    body: 'Dragging a child row onto another parent: what should happen?',
    options: [
      { label: 'Reorder within its parent only', description: 'Matches today.' },
      { label: 'Allow moving to another parent' },
      { label: 'Disable drag for child rows' },
    ],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: '2026-11-14T10:00:00.000Z',
    expiresAt: null,
    default: null,
    contentKey: 'k',
    state: 'open',
    endedAt: null,
    answer: null,
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    permission: null,
    waiting: false,
    waitingUntil: null,
    ...over,
  };
}

async function mount(over: Partial<RequestView> = {}, extra: Partial<RequestTemplateProps> = {}) {
  const request = view({ id: over.id ?? `t${++seq}`, ...over });
  const handlers = {
    onSend: vi.fn(
      async (_answer: AnswerInput): Promise<RequestAnswerResult> => ({ ok: true, request }),
    ),
    onNext: vi.fn(),
    onOpenAsTab: vi.fn(),
    onOpenTerminal: vi.fn(),
    onClose: vi.fn(),
  };
  root = createRoot(host);
  const paint = (r: RequestView) =>
    act(() => {
      root?.render(
        <RequestTemplate
          request={r}
          sessionName="Conduit lane"
          mode="popup"
          moreCount={3}
          now={clock.t}
          {...handlers}
          {...extra}
        />,
      );
    });
  paint(request);
  return {
    ...handlers,
    request,
    rerender: (next: RequestView) => paint(next),
    unmount: async () => {
      const current = root;
      root = null;
      if (current) await act(async () => current.unmount());
    },
  };
}

const rootEl = () => must(host.querySelector<HTMLElement>('.reqtpl'), 'template root');

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
}

const sendBtn = () => must(buttonNamed(REQ_STR.send), 'Send button');

function optionInput(label: string): HTMLInputElement {
  const hit = Array.from(host.querySelectorAll('.reqtpl-option')).find(
    (o) => o.querySelector('.reqtpl-option__label')?.textContent === label,
  );
  return must(hit?.querySelector('input') ?? null, `option ${label}`);
}

function fieldFor(label: string): HTMLTextAreaElement {
  const l = must(
    Array.from(host.querySelectorAll('label')).find((x) => x.textContent === label),
    `label ${label}`,
  );
  const el = document.getElementById(l.htmlFor);
  if (!(el instanceof HTMLTextAreaElement)) throw new Error(`no textarea for ${label}`);
  return el;
}

function setField(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter');
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

function click(el: Element): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('RequestTemplate', () => {
  it("the header is Conduit's sentence and agent text is only in the quoted context", async () => {
    await mount();
    const header = must(host.querySelector('header'), 'header');
    const title = must(header.querySelector('h2'), 'header title');
    expect(title.textContent).toBe('claude-7 asks you to choose');
    expect(title.getAttribute('tabindex')).toBe('-1');
    expect(title.id).not.toBe('');
    expect(header.textContent).not.toContain('Drop rules for nested rows?');
    expect(header.textContent).not.toContain('Dragging a child row');
    expect(header.textContent).toContain('Conduit lane');
    const quote = must(host.querySelector('.needs-quote'), 'quote frame');
    expect(quote.getAttribute('dir')).toBe('auto');
    expect(quote.textContent).toContain('Drop rules for nested rows?');
    expect(quote.textContent).toContain('Dragging a child row');
    expect(header.contains(quote)).toBe(false);
  });

  it('confirm Yes sends approved; No sends declined; text alone sends answered', async () => {
    const yes = await mount({ id: 'c-yes', kind: 'confirm', options: [] });
    click(optionInput(REQ_STR.yes));
    await clickAsync(sendBtn());
    expect(yes.onSend).toHaveBeenCalledWith({ outcome: 'approved' });
    await yes.unmount();

    const no = await mount({ id: 'c-no', kind: 'confirm', options: [] });
    click(optionInput(REQ_STR.no));
    await clickAsync(sendBtn());
    expect(no.onSend).toHaveBeenCalledWith({ outcome: 'declined' });
    await no.unmount();

    const text = await mount({ id: 'c-text', kind: 'confirm', options: [] });
    setField(fieldFor(REQ_STR.ownWordsPlaceholder), 'Not yet');
    await clickAsync(sendBtn());
    expect(text.onSend).toHaveBeenCalledWith({ outcome: 'answered', text: 'Not yet' });
  });

  it('choose sends chosen with values and text; text alone sends answered', async () => {
    const picked = await mount({ id: 'ch-1' });
    click(optionInput('Allow moving to another parent'));
    setField(fieldFor(REQ_STR.ownWordsLabel), 'Because');
    await clickAsync(sendBtn());
    expect(picked.onSend).toHaveBeenCalledWith({
      outcome: 'chosen',
      values: ['Allow moving to another parent'],
      text: 'Because',
    });
    await picked.unmount();

    const alone = await mount({ id: 'ch-2' });
    setField(fieldFor(REQ_STR.ownWordsLabel), 'Something else');
    await clickAsync(sendBtn());
    expect(alone.onSend).toHaveBeenCalledWith({ outcome: 'answered', text: 'Something else' });
  });

  it('a multi choose allows several picks', async () => {
    const m = await mount({ id: 'multi-1', multi: true });
    expect(optionInput('Reorder within its parent only').type).toBe('checkbox');
    click(optionInput('Reorder within its parent only'));
    click(optionInput('Disable drag for child rows'));
    expect(optionInput('Reorder within its parent only').checked).toBe(true);
    expect(optionInput('Disable drag for child rows').checked).toBe(true);
    await clickAsync(sendBtn());
    expect(m.onSend).toHaveBeenCalledWith({
      outcome: 'chosen',
      values: ['Reorder within its parent only', 'Disable drag for child rows'],
    });
  });

  it('a scheduler choose needs a pick', async () => {
    const m = await mount({ id: 'sch-1', source: 'scheduler', requester: 'conduit' });
    setField(fieldFor(REQ_STR.ownWordsLabel), 'Text without a pick');
    expect(sendBtn().disabled).toBe(true);
    expect(rootEl().textContent).toContain(REQ_STR.reqTpl.needPick);
    click(optionInput('Allow moving to another parent'));
    expect(sendBtn().disabled).toBe(false);
    await clickAsync(sendBtn());
    expect(m.onSend).toHaveBeenCalledWith({
      outcome: 'chosen',
      values: ['Allow moving to another parent'],
      text: 'Text without a pick',
    });
  });

  it('review sends edited with the edited draft, approved as written, or declined with the note', async () => {
    const draft = 'line one\nline two\nline three';
    const edits = await mount(
      { id: 'rv-edit', kind: 'review', draft, options: [] },
      { mode: 'tab' },
    );
    const edited = 'line one\nLINE two\nline three\nnew line';
    setField(fieldFor(REQ_STR.reqTpl.editedLabel), edited);
    click(optionInput(REQ_STR.approveWithEdits));
    await clickAsync(sendBtn());
    expect(edits.onSend).toHaveBeenCalledWith({ outcome: 'edited', text: edited });
    await edits.unmount();

    const written = await mount(
      { id: 'rv-written', kind: 'review', draft, options: [] },
      { mode: 'tab' },
    );
    click(optionInput(REQ_STR.approveAsWritten));
    await clickAsync(sendBtn());
    expect(written.onSend).toHaveBeenCalledWith({ outcome: 'approved' });
    await written.unmount();

    const rejected = await mount(
      { id: 'rv-reject', kind: 'review', draft, options: [] },
      { mode: 'tab' },
    );
    click(optionInput(REQ_STR.reject));
    setField(fieldFor(REQ_STR.noteLabel), 'Too broad');
    await clickAsync(sendBtn());
    expect(rejected.onSend).toHaveBeenCalledWith({ outcome: 'declined', reason: 'Too broad' });
  });

  it('the draft shows line numbers and marks edited lines in the margin', async () => {
    const draft = 'line one\nline two\nline three';
    await mount({ id: 'rv-lines', kind: 'review', draft, options: [] }, { mode: 'tab' });
    const numbers = () =>
      Array.from(host.querySelectorAll('.reqtpl-draft__ln')).map((n) => n.textContent);
    const marked = () =>
      Array.from(host.querySelectorAll('.reqtpl-draft__ln--edited')).map((n) => n.textContent);
    expect(numbers()).toEqual(['1', '2', '3']);
    expect(marked()).toEqual([]);
    setField(fieldFor(REQ_STR.reqTpl.editedLabel), 'line one\nLINE two\nline three\nnew line');
    expect(numbers()).toEqual(['1', '2', '3', '4']);
    expect(marked()).toEqual(['2', '4']);
    click(must(buttonNamed(REQ_STR.reqTpl.originalTab), 'Original view'));
    expect(numbers()).toEqual(['1', '2', '3']);
    expect(marked()).toEqual([]);
  });

  it('Skip sends dismissed', async () => {
    const m = await mount({ id: 'skip-1' });
    await clickAsync(must(buttonNamed(REQ_STR.skip), 'Skip button'));
    expect(m.onSend).toHaveBeenCalledWith({ outcome: 'dismissed' });
  });

  it('number keys pick and Ctrl+Enter sends', async () => {
    const m = await mount({ id: 'keys-1' });
    press(rootEl(), '2');
    expect(optionInput('Allow moving to another parent').checked).toBe(true);
    press(rootEl(), 'Enter', { ctrlKey: true });
    await vi.waitFor(() => expect(m.onSend).toHaveBeenCalledTimes(1));
    expect(m.onSend).toHaveBeenCalledWith({
      outcome: 'chosen',
      values: ['Allow moving to another parent'],
    });
  });

  it('Enter on a focused, picked option sends', async () => {
    const m = await mount({ id: 'enter-1' });
    press(rootEl(), '3');
    press(optionInput('Disable drag for child rows'), 'Enter');
    await vi.waitFor(() => expect(m.onSend).toHaveBeenCalledTimes(1));
    expect(m.onSend).toHaveBeenCalledWith({
      outcome: 'chosen',
      values: ['Disable drag for child rows'],
    });
  });

  it('the swap guard ignores Send for 400 ms after the request changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A pick the user made earlier on the incoming request: during the guard, Send, a digit and
    // → would each act on it, so each one must be ignored.
    setDraft('guard-b', { pick: ['0'], text: '' });
    const m = await mount({ id: 'guard-a' });
    m.rerender(view({ id: 'guard-b', title: 'The next request' }));

    clock.t += 100;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(sendBtn().getAttribute('aria-disabled')).toBe('true');
    press(rootEl(), '2');
    expect(optionInput('Allow moving to another parent').checked).toBe(false);
    press(rootEl(), 'Enter', { ctrlKey: true });
    press(rootEl(), 'ArrowRight');
    expect(m.onSend).not.toHaveBeenCalled();
    expect(m.onNext).not.toHaveBeenCalled();

    clock.t += SWAP_GUARD_MS - 100;
    act(() => {
      vi.advanceTimersByTime(SWAP_GUARD_MS - 100);
    });
    expect(sendBtn().getAttribute('aria-disabled')).toBe('false');
    press(rootEl(), 'Enter', { ctrlKey: true });
    expect(m.onSend).toHaveBeenCalledTimes(1);
    expect(m.onSend).toHaveBeenCalledWith({
      outcome: 'chosen',
      values: ['Reorder within its parent only'],
    });
  });

  it('a failed send shows the message and keeps the input', async () => {
    const m = await mount({ id: 'fail-1' });
    const failed: RequestAnswerResult = {
      ok: false,
      reason: 'already_ended',
      message: 'Already answered elsewhere.',
      request: null,
    };
    m.onSend.mockImplementationOnce(async () => failed);
    setField(fieldFor(REQ_STR.ownWordsLabel), 'Keep me');
    await clickAsync(sendBtn());
    expect(rootEl().textContent).toContain('Already answered elsewhere.');
    expect(fieldFor(REQ_STR.ownWordsLabel).value).toBe('Keep me');
    expect(m.onNext).not.toHaveBeenCalled();
  });

  it('a successful send shows the receipt then calls onNext', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const m = await mount({ id: 'recv-1' });
    setField(fieldFor(REQ_STR.ownWordsLabel), 'Done');
    await clickAsync(sendBtn());
    const receipt = must(host.querySelector('[aria-live="polite"]'), 'live region');
    expect(receipt.textContent).toBe(REQ_STR.receipt('claude-7'));
    expect(m.onNext).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(SWAP_GUARD_MS);
    });
    expect(m.onNext).toHaveBeenCalledTimes(1);
  });

  it('an ended request shows its banner and disables Send', async () => {
    await mount({
      id: 'ended-1',
      state: 'expired',
      endedAt: '2026-11-14T10:05:00.000Z',
    });
    const banner = must(host.querySelector('.reqtpl-ended'), 'ended banner');
    expect(banner.textContent).toBe(REQ_STR.expired);
    expect(sendBtn().disabled).toBe(true);
    expect(optionInput('Reorder within its parent only').disabled).toBe(true);
    expect(rootEl().textContent).toContain('Dragging a child row');
  });

  it('the draft survives unmount and remount', async () => {
    const first = await mount({ id: 'draft-1' });
    click(optionInput('Allow moving to another parent'));
    setField(fieldFor(REQ_STR.ownWordsLabel), 'Keep this note');
    await first.unmount();

    await mount({ id: 'draft-1' });
    expect(optionInput('Allow moving to another parent').checked).toBe(true);
    expect(fieldFor(REQ_STR.ownWordsLabel).value).toBe('Keep this note');
  });

  it('attend shows Open terminal and no Send', async () => {
    const m = await mount({
      id: 'attend-1',
      kind: 'attend',
      options: [],
      body: '',
      title: 'Prompt',
    });
    const header = must(host.querySelector('header'), 'header');
    expect(header.textContent).toContain(REQ_STR.waitingAtPrompt('claude-7'));
    expect(buttonNamed(REQ_STR.send)).toBeUndefined();
    expect(buttonNamed(REQ_STR.openAsTab)).toBeUndefined();
    const openButtons = Array.from(host.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === REQ_STR.openTerminal,
    );
    expect(openButtons.length).toBeGreaterThan(0);
    click(must(openButtons[0], 'Open terminal'));
    expect(m.onOpenTerminal).toHaveBeenCalledTimes(1);
  });
});

describe('RequestTemplate chrome', () => {
  it('the close button is popup only', async () => {
    await mount({ id: 'close-popup' }, { mode: 'popup' });
    expect(host.querySelector(`button[aria-label="${REQ_STR.reqTpl.close}"]`)).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;
    host.innerHTML = '';
    await mount({ id: 'close-tab' }, { mode: 'tab' });
    expect(host.querySelector(`button[aria-label="${REQ_STR.reqTpl.close}"]`)).toBeNull();
  });
});

describe('RequestTemplate remote permission', () => {
  const remoteAsk = (id: string, grantable: boolean, stale = false): Partial<RequestView> => ({
    id,
    kind: 'attend',
    blocked: 'permission',
    options: [],
    body: '',
    title: 'Open a session on Studio PC?',
    remote: {
      machineName: 'Studio PC',
      stale,
      permission: { tool: 'open_session', why: 'a routed open', grantable },
    },
  });

  it('a grantable permission shows Deny, Allow and Always; Allow sends no grant key', async () => {
    const m = await mount(remoteAsk('perm-allow', true));
    expect(buttonNamed(REQ_STR.reqTpl.permissionDeny)).toBeDefined();
    expect(buttonNamed(REQ_STR.reqTpl.permissionAllow)).toBeDefined();
    expect(buttonNamed(REQ_STR.reqTpl.permissionAlways)).toBeDefined();
    expect(rootEl().textContent).toContain('a routed open');
    expect(buttonNamed(REQ_STR.openTerminal)).toBeUndefined();
    click(must(buttonNamed(REQ_STR.reqTpl.permissionAllow), 'Allow'));
    await act(async () => undefined);
    expect(m.onSend).toHaveBeenCalledTimes(1);
    const [sent] = m.onSend.mock.calls[0] ?? [];
    expect(sent).toStrictEqual({ outcome: 'allowed' });
    expect(sent).not.toHaveProperty('grant');
  });

  it('Deny sends denied', async () => {
    const m = await mount(remoteAsk('perm-deny', true));
    await clickAsync(must(buttonNamed(REQ_STR.reqTpl.permissionDeny), 'Deny'));
    expect(m.onSend.mock.calls[0]?.[0]).toStrictEqual({ outcome: 'denied' });
  });

  it('Always for this target sends allowed with the peer, target, until-revoked grant', async () => {
    const m = await mount(remoteAsk('perm-always', true));
    await clickAsync(must(buttonNamed(REQ_STR.reqTpl.permissionAlways), 'Always'));
    expect(m.onSend.mock.calls[0]?.[0]).toStrictEqual({
      outcome: 'allowed',
      grant: { who: 'peer', on: 'target', for: 'until-revoked' },
    });
  });

  it('a permission that is not grantable has no Always', async () => {
    await mount(remoteAsk('perm-once', false));
    expect(buttonNamed(REQ_STR.reqTpl.permissionDeny)).toBeDefined();
    expect(buttonNamed(REQ_STR.reqTpl.permissionAllow)).toBeDefined();
    expect(buttonNamed(REQ_STR.reqTpl.permissionAlways)).toBeUndefined();
  });

  it('a stale machine disables every answer button, with a title saying why', async () => {
    await mount(remoteAsk('perm-stale', true, true));
    const hint = REQ_STR.reqTpl.offlineHint('Studio PC');
    for (const name of [
      REQ_STR.reqTpl.permissionDeny,
      REQ_STR.reqTpl.permissionAllow,
      REQ_STR.reqTpl.permissionAlways,
    ]) {
      const b = must(buttonNamed(name), name);
      expect(b.disabled).toBe(true);
      expect(b.title).toBe(hint);
    }
    expect(host.querySelector('.reqtpl-chip')?.textContent).toBe(REQ_STR.offline('Studio PC'));
  });

  it('a stale question locks its options and Send', async () => {
    const m = await mount({
      id: 'stale-q',
      remote: { machineName: 'Studio PC', stale: true, permission: null },
    });
    expect(optionInput('Reorder within its parent only').disabled).toBe(true);
    expect(sendBtn().disabled).toBe(true);
    click(sendBtn());
    expect(m.onSend).not.toHaveBeenCalled();
  });

  it('a refused answer shows its copy, naming the machine', async () => {
    const m = await mount(remoteAsk('perm-refused', true));
    m.onSend.mockImplementationOnce(async () => ({
      ok: false,
      reason: 'peer_unreachable',
      message: 'raw host text',
      request: null,
    }));
    await clickAsync(must(buttonNamed(REQ_STR.reqTpl.permissionAllow), 'Allow'));
    expect(rootEl().textContent).toContain(REQ_STR.reqTpl.refusal.peerUnreachable('Studio PC'));
    expect(rootEl().textContent).not.toContain('raw host text');
  });

  it('a pending answer disables the permission buttons and says Sending', async () => {
    const m = await mount(remoteAsk('perm-pending', true));
    let finish: (r: RequestAnswerResult) => void = () => undefined;
    m.onSend.mockImplementationOnce(
      () => new Promise<RequestAnswerResult>((resolve) => (finish = resolve)),
    );
    click(must(buttonNamed(REQ_STR.reqTpl.permissionDeny), 'Deny'));
    expect(rootEl().textContent).toContain(REQ_STR.reqTpl.sending);
    expect(must(buttonNamed(REQ_STR.reqTpl.permissionAllow), 'Allow').disabled).toBe(true);
    await act(async () => finish({ ok: true, request: m.request }));
  });

  it('a local attend row keeps its attend line and no permission buttons', async () => {
    await mount({ id: 'local-attend', kind: 'attend', options: [], body: '', title: 'Prompt' });
    expect(rootEl().textContent).toContain(REQ_STR.reqTpl.attendLine);
    expect(buttonNamed(REQ_STR.reqTpl.permissionAllow)).toBeUndefined();
    expect(buttonNamed(REQ_STR.openTerminal)).toBeDefined();
  });
});
