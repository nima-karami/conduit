// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NewSessionRoleBrief } from '../../webview/components/new-session-role-brief';
import {
  type BriefAction,
  type BriefDialogState,
  initialBriefState,
} from '../../webview/role-brief-state';
import { BRIEF_STR } from '../../webview/role-brief-strings';

let host: HTMLDivElement;
let root: Root | null = null;
const dispatch = vi.fn<(a: BriefAction) => void>();
const onBrowse = vi.fn();

const state = (over: Partial<BriefDialogState> = {}): BriefDialogState => ({
  ...initialBriefState(),
  supported: true,
  ...over,
});

async function render(s: BriefDialogState) {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(NewSessionRoleBrief, { state: s, dispatch, onBrowse, liveId: 'lv' }),
    );
  });
}
const radios = () => [...host.querySelectorAll<HTMLElement>('.ns-brief [role="radio"]')];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  dispatch.mockReset();
  onBrowse.mockReset();
});

describe('NewSessionRoleBrief', () => {
  it('renders nothing when unsupported', async () => {
    await render(state({ supported: false }));
    expect(host.innerHTML).toBe('');
  });

  it('offers three radios, four when the agent has a brief', async () => {
    await render(state());
    expect(radios().map((r) => r.textContent)).toEqual(['None', 'Text', 'File']);
    await render(state({ agentHas: true, mode: 'agent' }));
    expect(radios().map((r) => r.textContent)).toEqual(['From agent', 'None', 'Text', 'File']);
  });

  it('labels the radiogroup and checks the current mode', async () => {
    await render(state({ mode: 'text' }));
    const group = host.querySelector('[role="radiogroup"]');
    const label = host.querySelector(`[id="${group?.getAttribute('aria-labelledby')}"]`);
    expect(label?.textContent).toBe(BRIEF_STR.label);
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  });

  it('ArrowRight selects the next mode', async () => {
    await render(state());
    await act(async () => {
      radios()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'setMode', mode: 'text' });
  });

  it('clicking a radio sets the mode', async () => {
    await render(state());
    await act(async () => radios()[2].click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'setMode', mode: 'file' });
  });

  it('typing dispatches setText and the count reads 0.1 / 64 KiB for 100 bytes', async () => {
    await render(state({ mode: 'text', text: 'a'.repeat(100) }));
    const ta = host.querySelector<HTMLTextAreaElement>('textarea');
    expect(ta?.getAttribute('aria-label')).toBe(BRIEF_STR.textLabel);
    const desc = host.querySelector(`[id="${ta?.getAttribute('aria-describedby')}"]`);
    expect(desc?.textContent).toBe('0.1 / 64 KiB');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, 'hi');
      ta?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'setText', text: 'hi' });
  });

  it('file mode: Browse calls onBrowse and the path input dispatches setPath', async () => {
    await render(state({ mode: 'file', path: '/a.md', probe: { phase: 'ok', bytes: 1024 } }));
    const browse = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${BRIEF_STR.browseName}"]`,
    );
    await act(async () => browse?.click());
    expect(onBrowse).toHaveBeenCalledTimes(1);
    const input = host.querySelector<HTMLInputElement>(
      `input[aria-label="${BRIEF_STR.pathLabel}"]`,
    );
    expect(input?.value).toBe('/a.md');
    expect(input?.getAttribute('dir')).toBe('ltr');
    expect(host.textContent).toContain('1 / 64 KiB');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '/b.md',
      );
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'setPath', path: '/b.md' });
  });

  it('shows Checking… while probing', async () => {
    await render(state({ mode: 'file', path: '/a.md', probe: { phase: 'checking' } }));
    expect(host.textContent).toContain(BRIEF_STR.checking);
  });

  it('renders a probe error as role=alert', async () => {
    await render(
      state({ mode: 'file', path: '/a.md', probe: { phase: 'error', error: 'brief-invalid' } }),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      BRIEF_STR.errors['brief-invalid'],
    );
  });

  it('agent mode shows the first line and path, and an agent error as an alert', async () => {
    await render(
      state({
        agentHas: true,
        mode: 'agent',
        agentFirstLine: 'You are a reviewer',
        agentPath: '/p/brief.md',
        agentError: 'brief-unreadable',
      }),
    );
    expect(host.textContent).toContain('You are a reviewer');
    expect(host.querySelector('[dir="ltr"]')?.textContent).toBe('/p/brief.md');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      BRIEF_STR.errors['brief-unreadable'],
    );
  });

  it('over-cap text shows the too-large alert', async () => {
    await render(state({ mode: 'text', text: 'a'.repeat(70_000) }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      BRIEF_STR.errors['brief-too-large'],
    );
  });
});
