import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyPresence,
  parseRequestsFile,
  type RequestsFile,
  serializeRequestsFile,
} from '../../src/conduit-mcp/request-file';
import { createRequestsIo } from '../../src/conduit-mcp/request-file-fs';
import type { RequestRecord } from '../../src/conduit-mcp/request-types';
import { tempRoots } from '../helpers/temp-roots';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const { root, cleanup } = tempRoots('req-file-');
afterEach(cleanup);

const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  id: 'r_000000000001',
  origin: 'm-abcd1234',
  source: 'agent',
  kind: 'choose',
  requester: 'alice',
  session: 's1',
  space: 'p1',
  lead: 's1',
  machine: 'm-abcd1234',
  title: 'Pick one',
  body: 'body',
  options: [{ label: 'A' }, { label: 'B', description: 'bee' }],
  multi: false,
  draft: null,
  thread: null,
  messageId: null,
  blocked: null,
  priority: 'normal',
  createdAt: '2026-11-14T11:00:00.000Z',
  expiresAt: '2026-11-14T13:00:00.000Z',
  default: { outcome: 'chosen', values: ['A'] },
  contentKey: 'k1',
  state: 'answered',
  endedAt: '2026-11-14T11:30:00.000Z',
  answer: {
    outcome: 'chosen',
    values: ['B'],
    answeredBy: { kind: 'you', windowId: 3 },
    at: '2026-11-14T11:30:00.000Z',
  },
  withdrawnBy: null,
  withdrawReason: null,
  supersededBy: null,
  deliveredAt: null,
  permission: null,
  ...over,
});

const EMPTY: RequestsFile = { version: 1, requests: [], presence: emptyPresence(NOW) };

describe('request file', () => {
  it('round-trips a file', () => {
    const file: RequestsFile = {
      version: 1,
      requests: [
        record(),
        record({
          id: 'r_000000000002',
          kind: 'confirm',
          options: [],
          default: null,
          expiresAt: null,
          state: 'open',
          endedAt: null,
          answer: null,
          blocked: 'permission',
          source: 'observed',
          requester: 'conduit',
          messageId: 'msg-1',
          draft: 'draft text',
          withdrawnBy: 'requester',
          withdrawReason: 'changed mind',
          supersededBy: 'r_000000000003',
        }),
        record({
          id: 'r_000000000004',
          answer: {
            outcome: 'declined',
            reason: 'no',
            answeredBy: { kind: 'default' },
            at: '2026-11-14T11:31:00.000Z',
          },
        }),
      ],
      presence: {
        state: 'away',
        since: '2026-11-14T11:40:00.000Z',
        until: null,
        lastAway: { from: '2026-11-14T10:00:00.000Z', to: '2026-11-14T10:30:00.000Z' },
      },
    };
    const text = serializeRequestsFile(file);
    expect(JSON.parse(text)).toEqual(file);
    const parsed = parseRequestsFile(text, NOW);
    expect(parsed.kind).toBe('ok');
    expect(parsed.file).toEqual(file);
  });

  it('null text is empty', () => {
    const parsed = parseRequestsFile(null, NOW);
    expect(parsed.kind).toBe('empty');
    expect(parsed.file).toEqual(EMPTY);
    expect(emptyPresence(NOW)).toEqual({
      state: 'here',
      since: '2026-11-14T12:00:00.000Z',
      until: null,
      lastAway: null,
    });
  });

  it('garbage is corrupt and empty', () => {
    for (const text of ['not json{', '[1,2]', '42', 'null', '{"version":0,"requests":[]}']) {
      const parsed = parseRequestsFile(text, NOW);
      expect(parsed.kind, text).toBe('corrupt');
      expect(parsed.file, text).toEqual(EMPTY);
    }
  });

  it('version 2 is newer', () => {
    const text = JSON.stringify({ ...EMPTY, version: 2, requests: [record()] });
    const parsed = parseRequestsFile(text, NOW);
    expect(parsed.kind).toBe('newer');
    expect(parsed.file).toEqual(EMPTY);
  });

  it('drops a malformed record and keeps the rest', () => {
    const good = record();
    const good2 = record({ id: 'r_000000000009', answer: null, state: 'open', endedAt: null });
    const badAnswer = {
      ...good.answer,
      answeredBy: { kind: 'you', windowId: 'x' },
    };
    const requests: unknown[] = [
      good,
      { ...good, state: 'bogus' },
      good2,
      { ...good, answer: badAnswer },
      { ...good, options: [{ label: 3 }] },
      { ...good, title: undefined },
      null,
    ];
    const text = JSON.stringify({ version: 1, requests, presence: EMPTY.presence });
    const parsed = parseRequestsFile(text, NOW);
    expect(parsed.kind).toBe('ok');
    expect(parsed.file.requests).toEqual([good, good2]);
    expect(parsed.dropped).toBe(5);
  });

  it('permission record round-trips the file', () => {
    const answeredPermission = record({
      id: 'r_000000000005',
      source: 'policy',
      kind: 'permission',
      requester: 'alpha',
      lead: null,
      options: [],
      blocked: null,
      default: null,
      expiresAt: '2026-11-14T13:00:00.000Z',
      state: 'answered',
      endedAt: '2026-11-14T11:20:00.000Z',
      answer: {
        outcome: 'allowed',
        grant: { who: 'session', on: 'target', for: '1h' },
        answeredBy: { kind: 'you', windowId: 2 },
        at: '2026-11-14T11:20:00.000Z',
      },
      permission: {
        tool: 'send_message',
        why: 'reach s2',
        targets: [{ sessionId: 's2', path: null, folder: null, projectId: 'p1' }],
        lateGrant: null,
      },
    });
    const expiredPermission = record({
      ...answeredPermission,
      id: 'r_000000000006',
      state: 'expired',
      endedAt: '2026-11-14T13:00:00.000Z',
      answer: null,
      permission: {
        tool: 'open_session',
        why: 'start a worker',
        targets: [{ sessionId: null, path: '/work/a', folder: '/work', projectId: null }],
        lateGrant: 'g_000000000001',
      },
    });
    const file: RequestsFile = {
      version: 1,
      requests: [answeredPermission, expiredPermission],
      presence: EMPTY.presence,
    };
    const parsed = parseRequestsFile(serializeRequestsFile(file), NOW);
    expect(parsed.kind).toBe('ok');
    expect(parsed.dropped).toBe(0);
    expect(parsed.file).toEqual(file);
  });

  it('a permission with a malformed tool is dropped on read', () => {
    const bad: Record<string, unknown> = {
      ...record({ source: 'policy', kind: 'permission' }),
      permission: { tool: 'not_a_tool', why: 'x', targets: [], lateGrant: null },
    };
    const parsed = parseRequestsFile(
      JSON.stringify({ version: 1, requests: [bad], presence: EMPTY.presence }),
      NOW,
    );
    expect(parsed.file.requests).toEqual([]);
    expect(parsed.dropped).toBe(1);
  });

  it('kind permission must carry a permission, and only permission records may', () => {
    const noPermission: Record<string, unknown> = {
      ...record({ source: 'policy', kind: 'permission' }),
    };
    const strayPermission: Record<string, unknown> = {
      ...record(),
      permission: { tool: 'send_message', why: 'x', targets: [], lateGrant: null },
    };
    const parsed = parseRequestsFile(
      JSON.stringify({
        version: 1,
        requests: [noPermission, strayPermission],
        presence: EMPTY.presence,
      }),
      NOW,
    );
    expect(parsed.file.requests).toEqual([]);
    expect(parsed.dropped).toBe(2);
  });

  it('a record without the permission field reads as permission null', () => {
    const legacy: Record<string, unknown> = { ...record() };
    delete legacy.permission;
    const parsed = parseRequestsFile(
      JSON.stringify({ version: 1, requests: [legacy], presence: EMPTY.presence }),
      NOW,
    );
    expect(parsed.kind).toBe('ok');
    expect(parsed.file.requests).toEqual([record()]);
    expect(parsed.file.requests[0]?.permission).toBeNull();
  });

  it('bad presence falls back to here', () => {
    const text = JSON.stringify({
      version: 1,
      requests: [record()],
      presence: { state: 'sleeping', since: 'x', until: null, lastAway: null },
    });
    const parsed = parseRequestsFile(text, NOW);
    expect(parsed.kind).toBe('ok');
    expect(parsed.file.requests).toEqual([record()]);
    expect(parsed.file.presence).toEqual(emptyPresence(NOW));
  });

  it('io writes atomically and reads back', async () => {
    const file = path.join(root(), 'conduit-mcp', 'requests.json');
    const io = createRequestsIo(file);
    expect(io.read()).toBeNull();
    const first = serializeRequestsFile({ ...EMPTY, requests: [record()] });
    await io.write(first);
    expect(io.read()).toBe(first);
    const second = serializeRequestsFile(EMPTY);
    await io.write(second);
    expect(io.read()).toBe(second);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['requests.json']);
  });

  it('io read returns null for a missing file', () => {
    const io = createRequestsIo(path.join(root(), 'absent.json'));
    expect(io.read()).toBeNull();
  });

  it('io read rethrows errors other than a missing file', () => {
    const io = createRequestsIo(root());
    expect(() => io.read()).toThrow();
  });
});
