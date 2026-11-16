import { describe, expect, it, vi } from 'vitest';
import {
  checkRemoteAnswer,
  createRemoteRequests,
  mergeListRequests,
  mergeRemoteRequests,
  type RemoteRequestView,
} from '../../src/conduit-mcp/remote-requests';
import type { ListRequestsOutput, RequestsUiState } from '../../src/conduit-mcp/request-types';
import { type Result, toolError } from '../../src/conduit-mcp/types';
import type { RequestMirror } from '../../src/contracts/link-protocol';

const mirror = (over: Partial<RequestMirror> & { id: string }): RequestMirror => ({
  kind: 'confirm',
  title: `ask ${over.id}`,
  body: '',
  options: [],
  multi: false,
  draft: null,
  priority: 'normal',
  createdAt: '2026-11-16T10:00:00.000Z',
  expiresAt: null,
  requester: 'builder@win-box',
  state: 'open',
  answer: null,
  permission: null,
  ...over,
});

const perm = (grantable: boolean): RequestMirror['permission'] => ({
  tool: 'open_session',
  why: 'a routed open',
  grantable,
});

function store() {
  const onChanged = vi.fn();
  return { s: createRemoteRequests({ onChanged }), onChanged };
}

describe('remote request mirror: apply and seq', () => {
  it('replaces a machine set wholesale when the seq is newer', () => {
    const { s } = store();
    s.apply('m-aaaa1111', 1, [mirror({ id: 'r1' }), mirror({ id: 'r2' })], 'win-box');
    s.apply('m-aaaa1111', 2, [mirror({ id: 'r3' })], 'win-box');
    expect(s.views().map((v) => v.id)).toEqual(['r3@m-aaaa1111']);
  });

  it('ignores an older seq and an equal seq', () => {
    const { s, onChanged } = store();
    s.apply('m-aaaa1111', 5, [mirror({ id: 'new' })], 'win-box');
    onChanged.mockClear();
    expect(s.apply('m-aaaa1111', 4, [mirror({ id: 'old' })], 'win-box')).toBe(false);
    expect(s.apply('m-aaaa1111', 5, [mirror({ id: 'same' })], 'win-box')).toBe(false);
    expect(s.views().map((v) => v.id)).toEqual(['new@m-aaaa1111']);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('keeps machines apart: one machine never replaces another', () => {
    const { s } = store();
    s.apply('m-aaaa1111', 1, [mirror({ id: 'a' })], 'win-box');
    s.apply('m-bbbb2222', 1, [mirror({ id: 'b' })], 'mac');
    s.apply('m-aaaa1111', 2, [], 'win-box');
    expect(s.views().map((v) => v.id)).toEqual(['b@m-bbbb2222']);
  });

  it('notifies once per accepted snapshot', () => {
    const { s, onChanged } = store();
    s.apply('m-aaaa1111', 1, [mirror({ id: 'a' })], 'win-box');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('remote request mirror: link state', () => {
  it('down marks the machine requests stale and keeps them', () => {
    const { s } = store();
    s.apply('m-aaaa1111', 1, [mirror({ id: 'a' })], 'win-box');
    s.setLinkState('m-aaaa1111', 'down');
    expect(s.views()).toMatchObject([{ id: 'a@m-aaaa1111', stale: true }]);
  });

  it('a fresh snapshot clears stale', () => {
    const { s } = store();
    s.apply('m-aaaa1111', 1, [mirror({ id: 'a' })], 'win-box');
    s.setLinkState('m-aaaa1111', 'down');
    s.apply('m-aaaa1111', 2, [mirror({ id: 'b' })], 'win-box');
    expect(s.views()).toMatchObject([{ id: 'b@m-aaaa1111', stale: false }]);
  });

  it('up after a drop accepts the next link snapshot even when its seq restarts', () => {
    const { s } = store();
    s.apply('m-aaaa1111', 7, [mirror({ id: 'a' })], 'win-box');
    s.setLinkState('m-aaaa1111', 'down');
    s.setLinkState('m-aaaa1111', 'up');
    expect(s.apply('m-aaaa1111', 1, [mirror({ id: 'b' })], 'win-box')).toBe(true);
    expect(s.views()).toMatchObject([{ id: 'b@m-aaaa1111', stale: false }]);
  });

  it('gone clears the machine and a later snapshot is accepted from seq 1', () => {
    const { s } = store();
    s.apply('m-aaaa1111', 9, [mirror({ id: 'a' })], 'win-box');
    s.setLinkState('m-aaaa1111', 'gone');
    expect(s.views()).toEqual([]);
    expect(s.resolve('a@m-aaaa1111')).toBeNull();
    expect(s.apply('m-aaaa1111', 1, [mirror({ id: 'b' })], 'win-box')).toBe(true);
  });

  it('notifies on a link state change', () => {
    const { s, onChanged } = store();
    s.apply('m-aaaa1111', 1, [mirror({ id: 'a' })], 'win-box');
    onChanged.mockClear();
    s.setLinkState('m-aaaa1111', 'down');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('remote request mirror: ids and views', () => {
  it('ids are <requestId>@<machineId> and resolve back to the machine and request', () => {
    const { s } = store();
    s.apply('m-aaaa1111', 1, [mirror({ id: 'req-1' })], 'win-box');
    const [view] = s.views();
    expect(view?.id).toBe('req-1@m-aaaa1111');
    expect(s.resolve(view?.id ?? '')).toMatchObject({
      machineId: 'm-aaaa1111',
      requestId: 'req-1',
      mirror: { id: 'req-1' },
    });
  });

  it('resolves nothing for an id of another machine or an unknown request', () => {
    const { s } = store();
    s.apply('m-aaaa1111', 1, [mirror({ id: 'req-1' })], 'win-box');
    expect(s.resolve('req-1@m-bbbb2222')).toBeNull();
    expect(s.resolve('req-9@m-aaaa1111')).toBeNull();
    expect(s.resolve('req-1')).toBeNull();
  });

  it('a view carries the machine as machine and origin, and the open or ended split', () => {
    const { s } = store();
    s.apply(
      'm-aaaa1111',
      1,
      [mirror({ id: 'open' }), mirror({ id: 'done', state: 'answered' })],
      'win-box',
    );
    const [open, done] = s.views();
    expect(open).toMatchObject({ machine: 'm-aaaa1111', origin: 'm-aaaa1111', state: 'open' });
    expect(done).toMatchObject({ state: 'answered' });
  });

  it('a permission mirror is an answerable approve request blocked on permission', () => {
    const { s } = store();
    s.apply(
      'm-aaaa1111',
      1,
      [mirror({ id: 'p', kind: 'permission', permission: perm(true) })],
      'win-box',
    );
    expect(s.views()[0]).toMatchObject({ kind: 'attend', blocked: 'permission', permission: null });
  });
});

describe('mergeRemoteRequests', () => {
  const local: RequestsUiState = {
    open: [],
    ended: [],
    presence: { state: 'here', since: '2026-11-16T09:00:00.000Z', until: null, lastAway: null },
  };

  it('appends open remote rows after local open rows and ended rows after local ended', () => {
    const s = createRemoteRequests({ onChanged: () => {} });
    s.apply(
      'm-aaaa1111',
      1,
      [mirror({ id: 'o' }), mirror({ id: 'e', state: 'expired' })],
      'win-box',
    );
    const merged = mergeRemoteRequests(local, s.views());
    expect(merged.open.map((r) => r.id)).toEqual(['o@m-aaaa1111']);
    expect(merged.ended.map((r) => r.id)).toEqual(['e@m-aaaa1111']);
    expect(merged.presence).toBe(local.presence);
  });

  it('keeps stale rows, marked stale', () => {
    const s = createRemoteRequests({ onChanged: () => {} });
    s.apply('m-aaaa1111', 1, [mirror({ id: 'o' })], 'win-box');
    s.setLinkState('m-aaaa1111', 'down');
    const [row] = mergeRemoteRequests(local, s.views()).open as RemoteRequestView[];
    expect(row?.stale).toBe(true);
  });
});

describe('mergeListRequests', () => {
  const localOk: Result<ListRequestsOutput> = {
    ok: true,
    value: {
      requests: [
        {
          request_id: 'local-1',
          kind: 'confirm',
          title: 'mine',
          state: 'open',
          created_at: '2026-11-16T09:00:00.000Z',
          expires_at: null,
          waiting: false,
          answer: null,
        },
      ],
    },
  };
  const s = createRemoteRequests({ onChanged: () => {} });
  s.apply(
    'm-aaaa1111',
    1,
    [mirror({ id: 'open' }), mirror({ id: 'done', state: 'answered' })],
    'win-box',
  );

  it('adds remote rows in the @machine form with a machine name, after the local rows', () => {
    const out = mergeListRequests(localOk, s.views(), { state: 'open' });
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.value.requests.map((r) => r.request_id)).toEqual(['local-1', 'open@m-aaaa1111']);
    expect(out.value.requests[0]).not.toHaveProperty('machine');
    expect(out.value.requests[1]).toMatchObject({ machine: 'win-box', waiting: false });
  });

  it('state all includes ended remote rows; the default is open only', () => {
    const all = mergeListRequests(localOk, s.views(), { state: 'all' });
    const open = mergeListRequests(localOk, s.views(), {});
    expect(all.ok && all.value.requests.map((r) => r.request_id)).toEqual([
      'local-1',
      'open@m-aaaa1111',
      'done@m-aaaa1111',
    ]);
    expect(open.ok && open.value.requests.map((r) => r.request_id)).toEqual([
      'local-1',
      'open@m-aaaa1111',
    ]);
  });

  it('applies the limit to the merged list', () => {
    const out = mergeListRequests(localOk, s.views(), { state: 'all', limit: 2 });
    expect(out.ok && out.value.requests.map((r) => r.request_id)).toEqual([
      'local-1',
      'open@m-aaaa1111',
    ]);
  });

  it('passes a local error through unchanged', () => {
    const err: Result<ListRequestsOutput> = { ok: false, error: toolError('invalid_args', 'bad') };
    expect(mergeListRequests(err, s.views(), {})).toBe(err);
  });
});

describe('checkRemoteAnswer', () => {
  // The renderer's grant is a scope; the wire body carries only that a grant is asked for.
  const GRANT = { who: 'session', on: 'target', for: '1h' };
  const s = createRemoteRequests({ onChanged: () => {} });
  s.apply(
    'm-aaaa1111',
    1,
    [
      mirror({ id: 'choice', kind: 'choose', options: [{ label: 'A' }] }),
      mirror({ id: 'grantable', kind: 'permission', permission: perm(true) }),
      mirror({ id: 'once', kind: 'permission', permission: perm(false) }),
      mirror({ id: 'ended', state: 'answered' }),
    ],
    'win-box',
  );
  const ref = (id: string) => {
    const r = s.resolve(`${id}@m-aaaa1111`);
    if (r === null) throw new Error(`no ${id}`);
    return r;
  };

  it('passes a choose answer through as a body', () => {
    expect(checkRemoteAnswer(ref('choice'), { outcome: 'chosen', values: ['A'] })).toEqual({
      ok: true,
      body: { outcome: 'chosen', values: ['A'] },
    });
  });

  it('refuses an answer to a request that already ended', () => {
    expect(checkRemoteAnswer(ref('ended'), { outcome: 'chosen', values: ['A'] })).toMatchObject({
      ok: false,
      reason: 'already_ended',
    });
  });

  it('allows a permission with grant only when the mirror says grantable', () => {
    expect(checkRemoteAnswer(ref('grantable'), { outcome: 'allowed', grant: GRANT })).toEqual({
      ok: true,
      body: { outcome: 'allowed', grant: true },
    });
  });

  it('refuses a grant on a permission that is not grantable', () => {
    expect(checkRemoteAnswer(ref('once'), { outcome: 'allowed', grant: GRANT })).toMatchObject({
      ok: false,
      reason: 'invalid_answer',
    });
  });

  it('allows a plain allow or deny on a permission that is not grantable', () => {
    expect(checkRemoteAnswer(ref('once'), { outcome: 'denied', reason: 'no' })).toEqual({
      ok: true,
      body: { outcome: 'denied', reason: 'no' },
    });
  });

  it('refuses allowed or denied on a request that is not a permission', () => {
    expect(checkRemoteAnswer(ref('choice'), { outcome: 'allowed' })).toMatchObject({
      ok: false,
      reason: 'invalid_answer',
    });
  });

  it('refuses a malformed answer', () => {
    expect(checkRemoteAnswer(ref('choice'), 'yes')).toMatchObject({
      ok: false,
      reason: 'invalid_answer',
    });
    expect(checkRemoteAnswer(ref('choice'), { outcome: 3 })).toMatchObject({
      ok: false,
      reason: 'invalid_answer',
    });
  });
});
