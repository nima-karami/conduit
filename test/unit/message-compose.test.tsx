// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AttachmentRecord } from '../../src/conduit-mcp/types';
import type { McpAttachmentPayload, McpSendResult } from '../../src/conduit-mcp/ui-types';
import { AttachmentViewModal } from '../../webview/components/attachment-view-modal';
import { MessageCompose } from '../../webview/components/message-compose';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The kind dropdown's menu is a Popover, which measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

function fakeApi(o: Partial<ConduitMcpApi> = {}): ConduitMcpApi {
  return {
    state: null,
    getThread: vi.fn(async () => null),
    send: vi.fn(
      async (): Promise<McpSendResult> => ({
        ok: true,
        value: { message_id: 'm1', thread_id: 't1', recipients: [] },
      }),
    ),
    getAttachment: vi.fn(async () => null),
    markRead: vi.fn(),
    allowMore: vi.fn(),
    pause: vi.fn(),
    retry: vi.fn(),
    ...o,
  };
}

async function render(el: ReturnType<typeof createElement>) {
  host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  await act(async () => {
    r.render(el);
  });
}

const TARGETS = [
  { handle: 'claude-1', label: 'api fix' },
  { handle: 'codex-2', label: 'web' },
];

function q<T extends Element>(sel: string): T {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
}

function recipient(handle: string): HTMLInputElement {
  const label = [...document.body.querySelectorAll('.mcpmsg-compose__recipient')].find((l) =>
    l.textContent?.includes(handle),
  );
  const box = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`no recipient ${handle}`);
  return box;
}

async function chooseKind(label: string) {
  await click(q('.selectfield'));
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!item) throw new Error(`no kind ${label}`);
  await click(item);
}

describe('MessageCompose', () => {
  it('Ctrl+Enter sends with selected recipients, priority, kind', async () => {
    const api = fakeApi();
    const onDone = vi.fn();
    await render(createElement(MessageCompose, { api, targets: TARGETS, replyTo: null, onDone }));
    await click(recipient('codex-2'));
    await click(q('[role="radio"][aria-label="Urgent"]'));
    await chooseKind('Request');
    const body = q<HTMLTextAreaElement>('textarea');
    await typeInto(body, 'x');
    await key(body, 'Enter', { ctrlKey: true });
    expect(api.send).toHaveBeenCalledTimes(1);
    const req = vi.mocked(api.send).mock.calls[0][0];
    expect(req).toEqual({ to: ['codex-2'], priority: 'urgent', kind: 'request', body: 'x' });
    expect('attachments' in req).toBe(false);
    expect(onDone).toHaveBeenCalled();
  });

  it('Esc cancels', async () => {
    const api = fakeApi();
    const onDone = vi.fn();
    await render(createElement(MessageCompose, { api, targets: TARGETS, replyTo: null, onDone }));
    await key(q('textarea'), 'Escape');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
  });

  it('failure lists per-recipient reasons and keeps the draft', async () => {
    const api = fakeApi({
      send: vi.fn(
        async (): Promise<McpSendResult> => ({
          ok: true,
          value: {
            message_id: 'm1',
            thread_id: 't1',
            recipients: [
              { handle: 'claude-1', status: 'queued' },
              { handle: 'codex-2', status: 'refused', reason: 'unknown_handle' },
            ],
          },
        }),
      ),
    });
    const onDone = vi.fn();
    await render(createElement(MessageCompose, { api, targets: TARGETS, replyTo: null, onDone }));
    await click(recipient('claude-1'));
    await click(recipient('codex-2'));
    await typeInto(q<HTMLTextAreaElement>('textarea'), 'hello');
    await key(q('textarea'), 'Enter', { ctrlKey: true });
    const alert = q('[role="alert"]');
    expect(alert.textContent).toContain('codex-2: no session by that name');
    expect(alert.textContent).not.toContain('claude-1');
    expect(onDone).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>('textarea').value).toBe('hello');
  });

  it('priority is a radiogroup with labelled options', async () => {
    await render(
      createElement(MessageCompose, {
        api: fakeApi(),
        targets: TARGETS,
        replyTo: null,
        onDone: vi.fn(),
      }),
    );
    const group = q('[role="radiogroup"]');
    expect(group.getAttribute('aria-label')).toBe('Priority');
    const labels = [...group.querySelectorAll('[role="radio"]')].map((r) =>
      r.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['FYI', 'Normal', 'Urgent']);
    expect(q('[role="radio"][aria-checked="true"]').getAttribute('aria-label')).toBe('Normal');
  });

  it('reply prefills thread and recipients, without you', async () => {
    const api = fakeApi();
    await render(
      createElement(MessageCompose, {
        api,
        targets: TARGETS,
        replyTo: { threadId: 't9', to: ['claude-1', 'you'] },
        onDone: vi.fn(),
      }),
    );
    expect(recipient('claude-1').checked).toBe(true);
    expect(recipient('codex-2').checked).toBe(false);
    expect(document.body.querySelector('input:not([type])')).toBeNull();
    await typeInto(q<HTMLTextAreaElement>('textarea'), 'on it');
    await key(q('textarea'), 'Enter', { ctrlKey: true });
    expect(vi.mocked(api.send).mock.calls[0][0]).toEqual({
      to: ['claude-1'],
      body: 'on it',
      priority: 'normal',
      kind: 'inform',
      threadId: 't9',
    });
  });
});

describe('AttachmentViewModal', () => {
  const rec = (mime: string, name = 'f'): AttachmentRecord => ({
    attachmentId: 'a1',
    name,
    mime,
    bytes: 5,
    sha256: 'x',
  });
  const payload = (mime: string, text: string): McpAttachmentPayload => ({
    name: 'f',
    mime,
    bytes: text.length,
    base64: btoa(text),
  });
  const open = async (mime: string, text: string) => {
    const api = fakeApi({ getAttachment: vi.fn(async () => payload(mime, text)) });
    await render(
      createElement(AttachmentViewModal, {
        api,
        messageId: 'm1',
        attachment: rec(mime, 'notes.txt'),
        onClose: vi.fn(),
      }),
    );
    await act(async () => {});
    return api;
  };

  it('renders text in a pre', async () => {
    const api = await open('text/plain', 'hello');
    expect(api.getAttachment).toHaveBeenCalledWith('m1', 'a1');
    expect(q('pre').textContent).toBe('hello');
    expect(q('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
  });

  it('renders an image as an img with a data URL', async () => {
    await open('image/png', 'PNG');
    const img = q<HTMLImageElement>('img');
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${btoa('PNG')}`);
    expect(document.body.querySelector('pre')).toBeNull();
  });

  it('shows metadata only for an unsupported type', async () => {
    await open('application/octet-stream', 'bin');
    expect(document.body.querySelector('pre')).toBeNull();
    expect(document.body.querySelector('img')).toBeNull();
    expect(q('.mcpmsg-attview__facts').textContent).toContain('application/octet-stream');
    expect(q('.mcpmsg-attview__note').textContent).toBe('This attachment can’t be shown here.');
  });
});
