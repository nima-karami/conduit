// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestsUiState, RequestView } from '../../src/conduit-mcp/request-types';
import type { Session } from '../../src/types';
import { NeedsYouPane, type NeedsYouPaneProps } from '../../webview/components/needs-you-pane';
import { NO_FILTERS, type RequestFilters } from '../../webview/request-view-model';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
});

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function rv(p: Partial<RequestView> & { id: string }): RequestView {
  return {
    origin: 'm1',
    source: 'agent',
    kind: 'confirm',
    requester: 'claude-7',
    session: 's1',
    space: 'sp1',
    lead: null,
    machine: 'this computer',
    title: 'Delete 41 stale snapshot files?',
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: ago(8),
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
    waiting: false,
    waitingUntil: null,
    ...p,
  };
}

function sess(id: string, name: string, handle: string): Session {
  return {
    id,
    name,
    agentId: 'claude',
    home: `/w/${id}`,
    roots: [],
    status: 'running',
    createdAt: NOW,
    lastActiveAt: NOW,
    mcpHandle: handle,
  };
}

const SESSIONS = [sess('s1', 'Nav parity', 'claude-7'), sess('s2', 'Release notes', 'claude-5')];

function ui(open: RequestView[], ended: RequestView[] = []): RequestsUiState {
  return {
    open,
    ended,
    presence: { state: 'here', since: ago(60), until: null, lastAway: null },
  };
}

const SHOW_NONE = { space: false, age: false, machine: false };

function props(over: Partial<NeedsYouPaneProps> = {}): NeedsYouPaneProps {
  return {
    requests: ui([]),
    sessions: SESSIONS,
    spaceNames: new Map([['sp1', 'Nimbus']]),
    sort: 'soonest',
    filters: NO_FILTERS,
    show: SHOW_NONE,
    onClearFilters: vi.fn(),
    menu: null,
    legendOpen: false,
    onCloseLegend: vi.fn(),
    onOpen: vi.fn(),
    onOpenTerminal: vi.fn(),
    now: NOW,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(p: NeedsYouPaneProps): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<NeedsYouPane {...p} />));
  return host;
}

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function listbox(el: HTMLElement): HTMLElement {
  const lb = el.querySelector<HTMLElement>('[role="listbox"]');
  if (!lb) throw new Error('no listbox');
  return lb;
}

function options(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('[role="option"]')];
}

function titled(el: HTMLElement, text: string): HTMLElement {
  const o = options(el).find((x) => x.getAttribute('aria-label')?.includes(text));
  if (!o) throw new Error(`no option ${text}`);
  return o;
}

function key(el: HTMLElement, k: string): void {
  act(() => {
    listbox(el).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

function buttonNamed(el: HTMLElement, text: string): HTMLButtonElement {
  const b = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (x) => x.textContent?.trim() === text,
  );
  if (!b) throw new Error(`no button ${text}`);
  return b;
}

describe('NeedsYouPane', () => {
  it('renders one option per open request with its accessible name', () => {
    const el = render(
      props({
        requests: ui([
          rv({ id: 'a' }),
          rv({
            id: 'b',
            kind: 'choose',
            title: 'Which tenant?',
            requester: 'claude-5',
            session: 's2',
          }),
          rv({ id: 'c', kind: 'review', title: 'Changelog', session: 's2', requester: 'codex-2' }),
        ]),
      }),
    );
    const opts = options(el);
    expect(opts).toHaveLength(3);
    expect(opts[0].getAttribute('aria-label')).toBe(
      'Approve, Nav parity, claude-7: Delete 41 stale snapshot files?, 8m',
    );
    expect(opts[1].getAttribute('aria-label')).toBe(
      'Answer, Release notes, claude-5: Which tenant?, 8m',
    );
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe(opts[0].id);
  });

  it('the Conduit chip shows only on Conduit requests', () => {
    const el = render(
      props({
        requests: ui([
          rv({ id: 'agent' }),
          rv({ id: 'conduit', requester: 'conduit', source: 'agent', title: 'Retry?' }),
          rv({ id: 'observed', requester: 'claude-7', source: 'observed', title: 'Prompt' }),
        ]),
      }),
    );
    const opts = options(el);
    expect(opts[0].textContent).not.toContain('Conduit');
    expect(opts[1].textContent).toContain('Conduit');
    expect(opts[2].textContent).toContain('Conduit');
  });

  it('Enter opens the active request; J and K move', () => {
    const onOpen = vi.fn();
    const el = render(
      props({
        onOpen,
        requests: ui([rv({ id: 'a' }), rv({ id: 'b', title: 'Second?' })]),
      }),
    );
    key(el, 'j');
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe(options(el)[1].id);
    key(el, 'k');
    expect(listbox(el).getAttribute('aria-activedescendant')).toBe(options(el)[0].id);
    key(el, 'ArrowDown');
    key(el, 'Enter');
    expect(onOpen).toHaveBeenCalledWith('b');
  });

  it('O opens the terminal of the active row', () => {
    const onOpenTerminal = vi.fn();
    const el = render(
      props({
        onOpenTerminal,
        requests: ui([rv({ id: 'a', session: 's1' }), rv({ id: 'b', session: 's2' })]),
      }),
    );
    key(el, 'End');
    key(el, 'o');
    expect(onOpenTerminal).toHaveBeenCalledWith('s2');
  });

  it('H switches to History, which shows state words', () => {
    const el = render(
      props({
        requests: ui(
          [rv({ id: 'a' })],
          [
            rv({ id: 'e1', state: 'answered', answer: null, title: 'Done one' }),
            rv({
              id: 'e2',
              state: 'answered',
              title: 'Defaulted',
              answer: {
                outcome: 'chosen',
                values: ['Blue'],
                answeredBy: { kind: 'default' },
                at: ago(1),
              },
            }),
            rv({ id: 'e3', state: 'expired', title: 'Late' }),
            rv({ id: 'e4', state: 'withdrawn', withdrawnBy: 'requester', title: 'Pulled' }),
            rv({ id: 'e5', state: 'orphaned', title: 'Gone' }),
          ],
        ),
      }),
    );
    key(el, 'h');
    expect(buttonNamed(el, 'History').getAttribute('aria-pressed')).toBe('true');
    const text = el.textContent ?? '';
    expect(text).toContain('Answered');
    expect(text).toContain("Went with the agent's default");
    expect(text).toContain('Expired');
    expect(text).toContain('Withdrawn by claude-7');
    expect(text).toContain('Not delivered: the session was closed');
    expect(options(el)).toHaveLength(5);
  });

  it('the filter bar states the filter and Clear calls onClearFilters', () => {
    const onClearFilters = vi.fn();
    const filters: RequestFilters = { ...NO_FILTERS, sessions: ['s1'] };
    const el = render(
      props({
        onClearFilters,
        filters,
        requests: ui([rv({ id: 'a' }), rv({ id: 'b', session: 's2', title: 'Other' })]),
      }),
    );
    expect(el.textContent).toContain('Filtered: Nav parity · 1 of 2 shown');
    act(() => buttonNamed(el, 'Clear').click());
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('a waiting request stays listed under a filter that excludes it', () => {
    const el = render(
      props({
        filters: { ...NO_FILTERS, sessions: ['s1'] },
        requests: ui([
          rv({ id: 'a', session: 's1' }),
          rv({
            id: 'w',
            session: 's2',
            title: 'Blocked now',
            waiting: true,
            waitingUntil: ago(-1),
          }),
          rv({ id: 'x', session: 's2', title: 'Hidden' }),
        ]),
      }),
    );
    const texts = options(el).map((o) => o.getAttribute('aria-label') ?? '');
    expect(texts.some((t) => t.includes('Blocked now'))).toBe(true);
    expect(texts.some((t) => t.includes('Hidden'))).toBe(false);
    expect(texts).toHaveLength(2);
  });

  it('By session puts a heading before each session group', () => {
    const el = render(
      props({
        sort: 'session',
        requests: ui([
          rv({ id: 'a', session: 's1', title: 'A1' }),
          rv({ id: 'b', session: 's2', title: 'B1' }),
          rv({ id: 'c', session: 's1', title: 'A2' }),
          rv({ id: 'd', session: 's2', title: 'B2' }),
        ]),
      }),
    );
    const kids = [...listbox(el).children];
    const shape = kids.map((k) =>
      k.getAttribute('role') === 'presentation' ? `H:${k.textContent}` : 'O',
    );
    expect(shape).toEqual(['H:Nav parity', 'O', 'O', 'H:Release notes', 'O', 'O']);
  });

  it('empty, caught-up and filtered-empty states', () => {
    const empty = render(props({ requests: ui([]) }));
    expect(empty.textContent).toContain('Nothing needs you');
    expect(empty.textContent).toContain("Agents' questions and approvals appear here.");
    expect(empty.querySelector('[role="listbox"]')).toBeNull();
    act(() => root?.unmount());
    root = null;
    host?.remove();

    const caught = render(props({ requests: ui([], [rv({ id: 'e', state: 'resolved' })]) }));
    expect(caught.textContent).toContain('All caught up');
    expect(caught.textContent).not.toContain('Nothing needs you');
    act(() => root?.unmount());
    root = null;
    host?.remove();

    const onClearFilters = vi.fn();
    const filtered = render(
      props({
        onClearFilters,
        filters: { ...NO_FILTERS, types: ['review'] },
        requests: ui([rv({ id: 'a' })]),
      }),
    );
    expect(filtered.textContent).toContain('No requests match these filters');
    act(() => buttonNamed(filtered, 'Clear').click());
    expect(onClearFilters).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    root = null;
    host?.remove();

    const loading = render(props({ requests: null }));
    expect(loading.querySelectorAll('.needs-skeleton-row')).toHaveLength(3);
    expect(loading.querySelector('[role="listbox"]')).toBeNull();
  });

  it('show on cards adds the details line without repeating the age', () => {
    const el = render(
      props({
        show: { space: true, age: true, machine: true },
        requests: ui([
          rv({ id: 'plain', createdAt: ago(8) }),
          rv({ id: 'urgent', priority: 'urgent', createdAt: ago(8), title: 'Urgent one' }),
        ]),
      }),
    );
    const plain = titled(el, 'Delete 41');
    const urgent = titled(el, 'Urgent one');
    const details = (o: HTMLElement) => o.querySelector('.needs-row__details')?.textContent ?? '';
    const count = (s: string) => s.split('8m').length - 1;

    expect(details(plain)).toContain('Nimbus');
    expect(details(plain)).toContain('this computer');
    expect(details(plain)).not.toContain('8m');
    expect(count(plain.textContent ?? '')).toBe(1);

    expect(details(urgent)).toContain('8m');
    expect(count(urgent.textContent ?? '')).toBe(1);
  });
});
