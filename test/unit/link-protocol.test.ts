import { describe, expect, it } from 'vitest';
import {
  FS_MIN_MINOR,
  GIT_MIN_MINOR,
  helloPlatform,
  LINK_PROTOCOL,
  type LinkFrame,
  type MonitorSession,
  type MonitorSnapshot,
  OWN_DEFAULT_CAPABILITIES,
  parseLinkFrame,
  REQUEST_MIRROR_MIN_MINOR,
  type RequestMirror,
  ROUTED_TOOLS,
  type WireMessage,
} from '../../src/contracts/link-protocol';

const CAPS = { messaging: true, monitor: true, drive: false };
const SIZE = { cols: 120, rows: 40 };
const MESSAGE: WireMessage = {
  messageId: 'msg-1',
  threadId: 'th-1',
  from: 'claude-3',
  to: ['you'],
  subject: 'hi',
  kind: 'request',
  priority: 'normal',
  sentAt: '2026-11-14T10:00:00.000Z',
  body: 'hello',
  attachments: [{ name: 'a.txt', mime: 'text/plain', data: 'aGk=' }],
};
const SESSION: MonitorSession = {
  sessionId: 's-1',
  handle: 'claude-3',
  label: 'Claude',
  agent: 'cli:claude',
  presence: 'busy',
  messaging: 'connected',
  messageable: true,
  notices: 'typed',
  home: '/home/me/p',
  roots: ['/home/me/p'],
  attention: { attentionReason: 'blocked', completions: 2 },
  completions: 2,
  limit: null,
  status: 'running',
};
const SNAPSHOT: MonitorSnapshot = {
  seq: 7,
  sessions: [SESSION],
  requests: [
    {
      requestId: 'r-1',
      type: 'approval',
      summary: 'run tests',
      sessionHandle: 'claude-3',
      createdAt: '2026-11-14T10:00:00.000Z',
    },
  ],
  youUnread: 1,
  ownerPresence: 'here',
  agents: [{ id: 'cli:claude', label: 'Claude' }],
};

const MIRROR: RequestMirror = {
  id: 'r-1',
  kind: 'choose',
  title: 'Pick a branch',
  body: 'Which one?\nSay why.',
  options: [{ label: 'main', description: 'the default' }, { label: 'dev' }],
  multi: false,
  draft: null,
  priority: 'normal',
  createdAt: '2026-11-16T10:00:00.000Z',
  expiresAt: null,
  requester: 'claude-3',
  state: 'open',
  answer: null,
  permission: null,
};
const PERMISSION_MIRROR: RequestMirror = {
  ...MIRROR,
  id: 'r-2',
  kind: 'permission',
  title: 'Allow shell',
  body: '',
  draft: 'running tests',
  expiresAt: '2026-11-16T10:45:00.000Z',
  requester: 'claude-3@m-0a1b2c3d',
  state: 'answered',
  answer: { outcome: 'allowed', reason: 'ok', at: '2026-11-16T10:05:00.000Z' },
  permission: { tool: 'shell', why: 'run the tests', grantable: true },
};

/** One valid sample per frame `t`; the mapped type fails to compile if a frame is missing. */
const SAMPLES: { [K in LinkFrame['t']]: Extract<LinkFrame, { t: K }> } = {
  hello: {
    t: 'hello',
    protocol: { major: 1, minor: 0 },
    machineId: 'm-0a1b2c3d',
    serverKey: 'c2VydmVy',
    ownerKey: null,
    selfName: 'laptop',
    features: ['messaging', 'monitor'],
    capabilities: CAPS,
  },
  ping: { t: 'ping' },
  pong: { t: 'pong' },
  bye: { t: 'bye', reason: 'duplicate' },
  revoked: { t: 'revoked' },
  caps: { t: 'caps', capabilities: CAPS },
  msg: { t: 'msg', message: MESSAGE },
  ack: {
    t: 'ack',
    messageId: 'msg-1',
    recipients: [{ handle: 'claude-3', status: 'refused', reason: 'capability_off' }],
  },
  receipt: { t: 'receipt', messageId: 'msg-1', handle: 'claude-3', status: 'read' },
  snapshot: { t: 'snapshot', snapshot: SNAPSHOT },
  'view.open': { t: 'view.open', viewId: 'v-1', sessionId: 's-1' },
  'view.opened': {
    t: 'view.opened',
    viewId: 'v-1',
    firstPaint: 'Zmlyc3Q=',
    size: SIZE,
    windowsPty: { backend: 'conpty', buildNumber: 22631 },
  },
  'view.data': { t: 'view.data', viewId: 'v-1', data: 'aGk=' },
  'view.size': { t: 'view.size', viewId: 'v-1', size: SIZE },
  'view.end': { t: 'view.end', viewId: 'v-1', reason: 'exited', exitCode: 0 },
  'view.close': { t: 'view.close', viewId: 'v-1' },
  'drive.input': { t: 'drive.input', sessionId: 's-1', data: 'ls\r' },
  'drive.resize': { t: 'drive.resize', sessionId: 's-1', cols: 120, rows: 40 },
  'drive.open': { t: 'drive.open', requestId: 'q-1', agentId: 'cli:claude', folder: '/home/me/p' },
  'drive.close': { t: 'drive.close', requestId: 'q-1', sessionId: 's-1' },
  'drive.result': { t: 'drive.result', requestId: 'q-1', ok: true, sessionId: 's-1', error: null },
  owner: { t: 'owner', publicKey: 'pub', privateKey: 'priv' },
  'owner.ack': { t: 'owner.ack' },
  call: {
    t: 'call',
    id: 'c-1',
    tool: 'open_session',
    args: { machine: 'win-box', agent: 'cli:claude', path: '/home/me/p' },
    principal: { handle: 'claude-3' },
  },
  'call.result': { t: 'call.result', id: 'c-1', ok: true, result: { session_id: 's-1' } },
  'request.mirror': { t: 'request.mirror', seq: 4, requests: [MIRROR, PERMISSION_MIRROR] },
  'request.answer': {
    t: 'request.answer',
    answerId: 'a-1',
    requestId: 'r-1',
    answer: { outcome: 'chosen', values: ['main'] },
  },
  'request.answered': { t: 'request.answered', answerId: 'a-1', ok: true },
  'fs.req': { t: 'fs.req', id: 'f-1', op: 'read', sessionId: 's-1', path: '/home/u/work/a.txt' },
  'fs.res': {
    t: 'fs.res',
    id: 'f-1',
    ok: true,
    result: { op: 'list', path: '/home/u/work', entries: [{ name: 'a.txt', kind: 'file' }] },
  },
  'fs.watch': { t: 'fs.watch', watchId: 'w-1', sessionId: 's-1', path: '/home/u/work' },
  'fs.unwatch': { t: 'fs.unwatch', watchId: 'w-1' },
  'fs.changed': { t: 'fs.changed', watchId: 'w-1', paths: ['/home/u/work/a.txt'] },
  'git.req': {
    t: 'git.req',
    id: 'g-1',
    op: 'diff',
    sessionId: 's-1',
    root: '/w',
    args: { path: '/w/a.txt' },
  },
  'git.res': {
    t: 'git.res',
    id: 'g-1',
    ok: true,
    result: { op: 'show', files: [], truncated: false },
  },
};

const FRAME_TYPES = Object.keys(SAMPLES) as LinkFrame['t'][];
// `call` takes any JSON object as args and `call.result` any object as result, so the generic
// wrong-type sweep (which sets each field to `{}`) is not a rejection for them; they have their
// own explicit wrong-type cases below.
const SWEPT_TYPES = FRAME_TYPES.filter((t) => t !== 'call' && t !== 'call.result');

describe('parseLinkFrame', () => {
  it.each(FRAME_TYPES)('accepts a valid %s frame unchanged', (t) => {
    const sample = SAMPLES[t];
    expect(parseLinkFrame(structuredClone(sample))).toEqual(sample);
  });

  it.each(FRAME_TYPES)('rejects an unknown t in place of %s', (t) => {
    expect(parseLinkFrame({ ...SAMPLES[t], t: 'not-a-frame' })).toBeNull();
  });

  it.each(FRAME_TYPES)('rejects %s with any single top-level field missing', (t) => {
    const sample = SAMPLES[t] as Record<string, unknown>;
    for (const key of Object.keys(sample)) {
      const { [key]: _omitted, ...rest } = sample;
      expect(parseLinkFrame(rest), `${t} without ${key}`).toBeNull();
    }
  });

  it.each(SWEPT_TYPES)('rejects %s with any single top-level field of the wrong type', (t) => {
    const sample = SAMPLES[t] as Record<string, unknown>;
    for (const key of Object.keys(sample)) {
      if (key === 't') continue;
      expect(parseLinkFrame({ ...sample, [key]: {} }), `${t}.${key}={}`).toBeNull();
    }
  });

  it.each(FRAME_TYPES.filter((t) => t !== 'hello'))(
    'rejects %s with an extra top-level key',
    (t) => {
      expect(parseLinkFrame({ ...SAMPLES[t], extra: true })).toBeNull();
    },
  );

  it('reads a newer hello: extra keys and unknown features are dropped, not fatal', () => {
    expect(
      parseLinkFrame({
        ...SAMPLES.hello,
        extra: true,
        protocol: { major: 1, minor: 3, patch: 2 },
        features: ['telepathy', 'messaging'],
        capabilities: { ...CAPS, orchestrate: true },
      }),
    ).toEqual({
      ...SAMPLES.hello,
      protocol: { major: 1, minor: 3 },
      features: ['messaging'],
      capabilities: CAPS,
    });
  });

  it('rejects a hello whose protocol version is not integers', () => {
    expect(parseLinkFrame({ ...SAMPLES.hello, protocol: { major: 1.5, minor: 0 } })).toBeNull();
  });

  it('rejects sizes that are not positive integers', () => {
    expect(parseLinkFrame({ ...SAMPLES['view.size'], size: { cols: 0, rows: 24 } })).toBeNull();
    expect(parseLinkFrame({ ...SAMPLES['drive.resize'], cols: 80.5 })).toBeNull();
  });

  it('rejects non-object input', () => {
    for (const raw of [null, undefined, 'ping', 1, [], ['ping']]) {
      expect(parseLinkFrame(raw)).toBeNull();
    }
  });

  it('rejects a frame whose t is not a string', () => {
    expect(parseLinkFrame({ t: 1 })).toBeNull();
  });

  it('accepts a null windowsPty on view.opened', () => {
    const frame = { ...SAMPLES['view.opened'], windowsPty: null };
    expect(parseLinkFrame(frame)).toEqual(frame);
  });

  it('accepts a session with stuckReason present and rejects a non-string one', () => {
    const stuck = {
      ...SNAPSHOT,
      sessions: [
        {
          ...SESSION,
          attention: { attentionReason: 'stuck', completions: 0, stuckReason: 'waiting on CI' },
        },
      ],
    };
    expect(parseLinkFrame({ t: 'snapshot', snapshot: stuck })).not.toBeNull();
    const bad = {
      ...SNAPSHOT,
      sessions: [
        { ...SESSION, attention: { attentionReason: 'stuck', completions: 0, stuckReason: 3 } },
      ],
    };
    expect(parseLinkFrame({ t: 'snapshot', snapshot: bad })).toBeNull();
  });

  it('reads a snapshot session with an opener, and one from an older peer without it', () => {
    const local = { ...SESSION, openedBy: { handle: 'claude-1', machineId: null } };
    const remote = { ...SESSION, openedBy: { handle: 'claude-2', machineId: 'm-0000000a' } };
    const none = { ...SESSION, openedBy: null };
    for (const s of [local, remote, none, SESSION])
      expect(
        parseLinkFrame({ t: 'snapshot', snapshot: { ...SNAPSHOT, sessions: [s] } }),
      ).not.toBeNull();
  });

  it('rejects a snapshot opener with a bad handle, a bad machine id, or an extra key', () => {
    const bad = [
      { handle: 'x@m-cccccccc', machineId: null },
      { handle: 'claude-1', machineId: 'laptop' },
      { handle: 'claude-1', machineId: null, sessionId: 's' },
      { handle: 'claude-1' },
    ];
    for (const openedBy of bad)
      expect(
        parseLinkFrame({
          t: 'snapshot',
          snapshot: { ...SNAPSHOT, sessions: [{ ...SESSION, openedBy }] },
        }),
      ).toBeNull();
  });

  it('rejects a snapshot session whose handle is not a bare handle (CON-27 N2)', () => {
    for (const handle of ['x@m-cccccccc', 'Bad Handle', 'a\nb'])
      expect(
        parseLinkFrame({
          t: 'snapshot',
          snapshot: { ...SNAPSHOT, sessions: [{ ...SESSION, handle }] },
        }),
      ).toBeNull();
    for (const handle of ['claude-1', 'you', null])
      expect(
        parseLinkFrame({
          t: 'snapshot',
          snapshot: { ...SNAPSHOT, sessions: [{ ...SESSION, handle }] },
        }),
      ).not.toBeNull();
  });

  it('rejects an unknown enum value', () => {
    expect(parseLinkFrame({ t: 'bye', reason: 'bored' })).toBeNull();
    expect(parseLinkFrame({ ...SAMPLES.receipt, status: 'seen' })).toBeNull();
    expect(parseLinkFrame({ ...SAMPLES['view.end'], reason: 'lost' })).toBeNull();
    expect(
      parseLinkFrame({ ...SAMPLES['view.opened'], windowsPty: { backend: 'pty', buildNumber: 1 } }),
    ).toBeNull();
  });

  it('rejects an extra key inside a nested object', () => {
    expect(parseLinkFrame({ ...SAMPLES.caps, capabilities: { ...CAPS, view: true } })).toBeNull();
    expect(
      parseLinkFrame({
        t: 'msg',
        message: { ...MESSAGE, attachments: [{ name: 'a', mime: 'b', data: 'c', size: 1 }] },
      }),
    ).toBeNull();
    expect(
      parseLinkFrame({
        t: 'snapshot',
        snapshot: { ...SNAPSHOT, sessions: [{ ...SESSION, extra: 1 }] },
      }),
    ).toBeNull();
  });

  it('rejects a recipient outcome with a reason outside its union', () => {
    const frame = {
      ...SAMPLES.ack,
      recipients: [{ handle: 'x', status: 'refused', reason: 'bogus' }],
    };
    expect(parseLinkFrame(frame)).toBeNull();
  });
});

const ROUTED_CALL = SAMPLES.call;
const ROUTED_ERROR = {
  t: 'call.result',
  id: 'c-1',
  ok: false,
  error: { code: 'peer_unreachable', message: 'link dropped', retryable: true },
} as const;

describe('call and call.result frames (protocol 1.2)', () => {
  it('round-trips the routed-call frame and an error result', () => {
    expect(parseLinkFrame(structuredClone(ROUTED_CALL))).toEqual(ROUTED_CALL);
    expect(parseLinkFrame(structuredClone(ROUTED_ERROR))).toEqual(ROUTED_ERROR);
  });

  it('round-trips an error result with a hint', () => {
    const frame = {
      ...ROUTED_ERROR,
      error: { ...ROUTED_ERROR.error, hint: 'connect_machine win-box first' },
    };
    expect(parseLinkFrame(frame)).toEqual(frame);
  });

  it('exposes the minor version and the six routed tools', () => {
    expect(LINK_PROTOCOL).toEqual({ major: 1, minor: 5 });
    expect([...ROUTED_TOOLS]).toEqual([
      'list_agents',
      'open_session',
      'open_terminal',
      'send_input',
      'read_screen',
      'close_session',
    ]);
  });

  it('accepts each routed tool and rejects any other tool name', () => {
    for (const tool of ROUTED_TOOLS)
      expect(parseLinkFrame({ ...ROUTED_CALL, tool })).not.toBeNull();
    for (const tool of [
      'focus_session',
      'attach_folder',
      'drive_session',
      'OPEN_SESSION',
      '',
      'open_session ',
    ])
      expect(parseLinkFrame({ ...ROUTED_CALL, tool }), tool).toBeNull();
  });

  it('rejects args above 64 KiB once serialized, and accepts a small object', () => {
    expect(parseLinkFrame({ ...ROUTED_CALL, args: { blob: 'x'.repeat(1000) } })).not.toBeNull();
    expect(parseLinkFrame({ ...ROUTED_CALL, args: { blob: 'x'.repeat(64 * 1024) } })).toBeNull();
  });

  it('rejects args that are not a plain object', () => {
    for (const args of [null, [], ['open_session'], 'x', 1]) {
      expect(parseLinkFrame({ ...ROUTED_CALL, args }), JSON.stringify(args)).toBeNull();
    }
    expect(parseLinkFrame({ ...ROUTED_CALL, args: {} })).not.toBeNull();
  });

  it('rejects a principal that carries anything beyond its handle', () => {
    expect(
      parseLinkFrame({
        ...ROUTED_CALL,
        principal: { handle: 'claude-3', machineId: 'm-0a1b2c3d' },
      }),
    ).toBeNull();
    expect(parseLinkFrame({ ...ROUTED_CALL, principal: {} })).toBeNull();
    expect(parseLinkFrame({ ...ROUTED_CALL, principal: 'claude-3' })).toBeNull();
  });

  it('rejects a principal handle that is empty, over 64 chars, or not printable', () => {
    expect(parseLinkFrame({ ...ROUTED_CALL, principal: { handle: '' } })).toBeNull();
    expect(parseLinkFrame({ ...ROUTED_CALL, principal: { handle: 'h'.repeat(65) } })).toBeNull();
    expect(parseLinkFrame({ ...ROUTED_CALL, principal: { handle: 'a\nb' } })).toBeNull();
    expect(
      parseLinkFrame({ ...ROUTED_CALL, principal: { handle: 'h'.repeat(64) } }),
    ).not.toBeNull();
  });

  it('rejects a call id that is not a non-empty string of at most 64 chars', () => {
    for (const id of [1, '', 'i'.repeat(65)]) {
      expect(parseLinkFrame({ ...ROUTED_CALL, id }), String(id)).toBeNull();
    }
    expect(parseLinkFrame({ ...ROUTED_CALL, id: 'i'.repeat(64) })).not.toBeNull();
  });

  it('rejects a call with a wrong-typed tool or args', () => {
    expect(parseLinkFrame({ ...ROUTED_CALL, tool: {} })).toBeNull();
    expect(parseLinkFrame({ ...ROUTED_CALL, tool: 3 })).toBeNull();
  });

  it('rejects an error result missing code, message or retryable, or with an extra key', () => {
    for (const key of ['code', 'message', 'retryable']) {
      const { [key]: _omitted, ...rest } = ROUTED_ERROR.error as Record<string, unknown>;
      expect(parseLinkFrame({ ...ROUTED_ERROR, error: rest }), `without ${key}`).toBeNull();
    }
    expect(
      parseLinkFrame({ ...ROUTED_ERROR, error: { ...ROUTED_ERROR.error, extra: 1 } }),
    ).toBeNull();
  });

  it('rejects an error result whose code or hint is empty, over-long or not printable', () => {
    const err = ROUTED_ERROR.error;
    expect(parseLinkFrame({ ...ROUTED_ERROR, error: { ...err, code: '' } })).toBeNull();
    expect(parseLinkFrame({ ...ROUTED_ERROR, error: { ...err, code: 'c'.repeat(65) } })).toBeNull();
    expect(
      parseLinkFrame({ ...ROUTED_ERROR, error: { ...err, message: 'bad\u0007bell' } }),
    ).toBeNull();
    expect(
      parseLinkFrame({ ...ROUTED_ERROR, error: { ...err, hint: 'h'.repeat(513) } }),
    ).toBeNull();
    expect(parseLinkFrame({ ...ROUTED_ERROR, error: { ...err, hint: 'line\nbreak' } })).toBeNull();
  });

  it('rejects an ok flag and result that disagree with each other', () => {
    expect(parseLinkFrame({ ...SAMPLES['call.result'], ok: 'yes' })).toBeNull();
    expect(parseLinkFrame({ ...SAMPLES['call.result'], error: ROUTED_ERROR.error })).toBeNull();
    expect(parseLinkFrame({ ...ROUTED_ERROR, result: {} })).toBeNull();
    expect(parseLinkFrame({ t: 'call.result', id: 'c-1', ok: true })).toBeNull();
    expect(
      parseLinkFrame({ t: 'call.result', id: 'c-1', ok: true, result: ['not', 'an', 'object'] }),
    ).toBeNull();
  });
});

describe('OWN_DEFAULT_CAPABILITIES', () => {
  it('enables messaging and monitor, leaves drive off', () => {
    expect(OWN_DEFAULT_CAPABILITIES).toEqual({ messaging: true, monitor: true, drive: false });
  });
});

describe('hello platform and version (protocol 1.1)', () => {
  const withPlatform = {
    ...SAMPLES.hello,
    platform: { os: 'linux', arch: 'x64' },
    version: '0.64.1',
  };

  it('round-trips the platform and version a hello carries', () => {
    expect(parseLinkFrame(withPlatform)).toEqual(withPlatform);
  });

  it('ignores a malformed platform or version and keeps the hello', () => {
    const parsed = parseLinkFrame({
      ...SAMPLES.hello,
      platform: { os: 'plan9', arch: 'x64' },
      version: 'x'.repeat(65),
    });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('platform');
    expect(parsed).not.toHaveProperty('version');
  });

  it('a version with a control character is ignored', () => {
    const parsed = parseLinkFrame({ ...SAMPLES.hello, version: '1.0\n' });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('version');
  });

  it('an older hello without them still parses, with neither field', () => {
    const parsed = parseLinkFrame(SAMPLES.hello);
    expect(parsed).toEqual(SAMPLES.hello);
    expect(parsed).not.toHaveProperty('platform');
  });

  it('maps node platform and arch to the hello vocabulary; anything else is other', () => {
    expect(helloPlatform('linux', 'x64')).toEqual({ os: 'linux', arch: 'x64' });
    expect(helloPlatform('win32', 'x64')).toEqual({ os: 'windows', arch: 'x64' });
    expect(helloPlatform('linux', 'arm64')).toEqual({ os: 'linux', arch: 'arm64' });
    expect(helloPlatform('darwin', 'x64')).toEqual({ os: 'other', arch: 'x64' });
    expect(helloPlatform('linux', 'ia32')).toEqual({ os: 'linux', arch: 'other' });
  });
});

describe('request.mirror, request.answer and request.answered frames (protocol 1.3)', () => {
  const ANSWER = SAMPLES['request.answer'];
  const MIRROR_FRAME = SAMPLES['request.mirror'];
  const ANSWERED_ERROR = {
    t: 'request.answered',
    answerId: 'a-1',
    ok: false,
    error: { code: 'peer_unreachable', message: 'link dropped', retryable: true },
  } as const;

  it('serves the mirror from minor 3', () => {
    expect(REQUEST_MIRROR_MIN_MINOR).toBe(3);
  });

  it('round-trips the mirror with an answered permission, a draft and an expiry', () => {
    expect(parseLinkFrame(structuredClone(MIRROR_FRAME))).toEqual(MIRROR_FRAME);
  });

  it('round-trips an answered request.answered with an error and a hint', () => {
    const frame = {
      ...ANSWERED_ERROR,
      error: { ...ANSWERED_ERROR.error, hint: 'the owner retries' },
    };
    expect(parseLinkFrame(structuredClone(ANSWERED_ERROR))).toEqual(ANSWERED_ERROR);
    expect(parseLinkFrame(frame)).toEqual(frame);
  });

  it('rejects an ok=true answered frame that carries an error, and an ok=false one without', () => {
    expect(
      parseLinkFrame({ ...SAMPLES['request.answered'], error: ANSWERED_ERROR.error }),
    ).toBeNull();
    expect(parseLinkFrame({ t: 'request.answered', answerId: 'a-1', ok: false })).toBeNull();
  });

  it('rejects a request.answer with an extra key at either level', () => {
    expect(parseLinkFrame({ ...ANSWER, extra: true })).toBeNull();
    expect(parseLinkFrame({ ...ANSWER, answer: { ...ANSWER.answer, extra: 1 } })).toBeNull();
  });

  it('accepts a grant flag on an answer and rejects a non-boolean one', () => {
    const granted = { ...ANSWER, answer: { outcome: 'allowed', grant: true } };
    expect(parseLinkFrame(granted)).toEqual(granted);
    expect(parseLinkFrame({ ...ANSWER, answer: { outcome: 'allowed', grant: 'yes' } })).toBeNull();
  });

  it('caps an answer at 8 values, a 200-char reason and a 16 KB text', () => {
    const values = (n: number) => ({
      ...ANSWER,
      answer: { outcome: 'chosen', values: Array(n).fill('v') },
    });
    expect(parseLinkFrame(values(8))).not.toBeNull();
    expect(parseLinkFrame(values(9))).toBeNull();
    const reason = (n: number) => ({
      ...ANSWER,
      answer: { outcome: 'declined', reason: 'r'.repeat(n) },
    });
    expect(parseLinkFrame(reason(200))).not.toBeNull();
    expect(parseLinkFrame(reason(201))).toBeNull();
    const text = (n: number) => ({
      ...ANSWER,
      answer: { outcome: 'answered', text: 'x'.repeat(n) },
    });
    expect(parseLinkFrame(text(16 * 1024))).not.toBeNull();
    expect(parseLinkFrame(text(16 * 1024 + 1))).toBeNull();
  });

  it('rejects a body over 16 KB, counting bytes not characters', () => {
    const mirror = (body: string) => ({
      ...MIRROR_FRAME,
      requests: [{ ...MIRROR_FRAME.requests[0], body }],
    });
    expect(parseLinkFrame(mirror('x'.repeat(16 * 1024)))).not.toBeNull();
    expect(parseLinkFrame(mirror('x'.repeat(16 * 1024 + 1)))).toBeNull();
    // 8 Ki two-byte characters is 16 KB + 2 bytes: over the cap though it is under 16 Ki chars.
    expect(parseLinkFrame(mirror('é'.repeat(8 * 1024 + 1)))).toBeNull();
  });

  it('keeps newlines in a body but refuses other control characters', () => {
    const mirror = (body: string) => ({
      ...MIRROR_FRAME,
      requests: [{ ...MIRROR_FRAME.requests[0], body }],
    });
    expect(parseLinkFrame(mirror('line one\n\tline two\r\n'))).not.toBeNull();
    expect(parseLinkFrame(mirror('bad\u0007bell'))).toBeNull();
  });

  it('rejects a mirror with more than 200 requests and accepts exactly 200', () => {
    const many = (n: number) => ({
      ...MIRROR_FRAME,
      requests: Array.from({ length: n }, () => MIRROR),
    });
    expect(parseLinkFrame(many(200))).not.toBeNull();
    expect(parseLinkFrame(many(201))).toBeNull();
  });

  it('rejects a seq that is not a non-negative integer', () => {
    for (const seq of [-1, 1.5, '3', null, Number.NaN]) {
      expect(parseLinkFrame({ ...MIRROR_FRAME, seq }), String(seq)).toBeNull();
    }
    expect(parseLinkFrame({ ...MIRROR_FRAME, seq: 0 })).not.toBeNull();
  });

  it('rejects a non-printable or over-long requester, and accepts one of 64 chars', () => {
    const mirror = (requester: string) => ({
      ...MIRROR_FRAME,
      requests: [{ ...MIRROR_FRAME.requests[0], requester }],
    });
    for (const requester of ['claude\u0007', 'a\nb', '', 'h'.repeat(65)]) {
      expect(parseLinkFrame(mirror(requester)), JSON.stringify(requester)).toBeNull();
    }
    expect(parseLinkFrame(mirror('h'.repeat(64)))).not.toBeNull();
  });

  it('rejects a permission of the wrong shape and accepts null', () => {
    const withPermission = (permission: unknown) => ({
      ...MIRROR_FRAME,
      requests: [{ ...MIRROR_FRAME.requests[0], permission }],
    });
    expect(parseLinkFrame(withPermission(null))).not.toBeNull();
    expect(parseLinkFrame(withPermission({ tool: 'shell', why: 'x' }))).toBeNull();
    expect(
      parseLinkFrame(withPermission({ tool: 'shell', why: 'x', grantable: true, extra: 1 })),
    ).toBeNull();
    expect(
      parseLinkFrame(withPermission({ tool: 'shell', why: 'x', grantable: 'yes' })),
    ).toBeNull();
    expect(parseLinkFrame(withPermission('shell'))).toBeNull();
  });

  it('rejects a mirror request with an extra key, an unknown kind, or an unknown state', () => {
    const first = MIRROR_FRAME.requests[0];
    const mirror = (patch: Record<string, unknown>) => ({
      ...MIRROR_FRAME,
      requests: [{ ...first, ...patch }],
    });
    expect(parseLinkFrame(mirror({ session: null }))).toBeNull();
    expect(parseLinkFrame(mirror({ kind: 'attend-me' }))).toBeNull();
    expect(parseLinkFrame(mirror({ state: 'lost' }))).toBeNull();
  });
});

describe('fs frames (protocol 1.4)', () => {
  it('serves files from minor 4', () => {
    expect(FS_MIN_MINOR).toBe(4);
  });
  it('refuses an fs.req with an unknown op, a control character in the path, or an extra key', () => {
    const ok = { t: 'fs.req', id: 'f-1', op: 'read', sessionId: 's-1', path: '/w/a.txt' };
    expect(parseLinkFrame(structuredClone(ok))).toEqual(ok);
    expect(parseLinkFrame({ ...ok, op: 'write' })).toBeNull();
    expect(parseLinkFrame({ ...ok, path: '/w/a\u0000.txt' })).toBeNull();
    expect(parseLinkFrame({ ...ok, machineId: 'm-1' })).toBeNull();
  });
  it('refuses an fs.res whose ok and fields disagree or whose code is unknown', () => {
    expect(
      parseLinkFrame({
        t: 'fs.res',
        id: 'f-1',
        ok: false,
        error: { code: 'refused', message: 'no' },
      }),
    ).not.toBeNull();
    expect(
      parseLinkFrame({ t: 'fs.res', id: 'f-1', ok: false, error: { code: 'nope', message: 'no' } }),
    ).toBeNull();
    expect(
      parseLinkFrame({
        t: 'fs.res',
        id: 'f-1',
        ok: true,
        error: { code: 'refused', message: 'no' },
      }),
    ).toBeNull();
  });
  it('round-trips a read result with an image and refuses an unknown read-only reason', () => {
    const file = {
      path: '/w/p.png',
      content: '',
      language: 'plaintext',
      truncated: false,
      binary: true,
      image: { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==', bytes: 1 },
    };
    const res = { t: 'fs.res', id: 'f-2', ok: true, result: { op: 'read', file } };
    expect(parseLinkFrame(structuredClone(res))).toEqual(res);
    expect(
      parseLinkFrame({ ...res, result: { op: 'read', file: { ...file, readOnlyReason: 'x' } } }),
    ).toBeNull();
  });
  it('caps fs.changed at 256 paths', () => {
    const paths = Array.from({ length: 257 }, (_, i) => `/w/${i}`);
    expect(parseLinkFrame({ t: 'fs.changed', watchId: 'w-1', paths })).toBeNull();
    expect(
      parseLinkFrame({ t: 'fs.changed', watchId: 'w-1', paths: paths.slice(1) }),
    ).not.toBeNull();
  });
});

describe('git frames (protocol 1.5)', () => {
  it('serves git reads from the current minor', () => {
    expect(GIT_MIN_MINOR).toBe(LINK_PROTOCOL.minor);
  });
  it('refuses a git.req with a bad sha, an oversized limit, an unknown op or an extra arg', () => {
    const ok = {
      t: 'git.req',
      id: 'g-1',
      op: 'log',
      sessionId: 's-1',
      root: '/w',
      args: { limit: 50 },
    };
    expect(parseLinkFrame(structuredClone(ok))).toEqual(ok);
    expect(parseLinkFrame({ ...ok, args: { limit: 501 } })).toBeNull();
    expect(parseLinkFrame({ ...ok, op: 'commit' })).toBeNull();
    expect(parseLinkFrame({ ...ok, op: 'show', args: { sha: 'HEAD; rm -rf /' } })).toBeNull();
    expect(parseLinkFrame({ ...ok, op: 'diff', args: {} })).toBeNull();
    expect(parseLinkFrame({ ...ok, op: 'status', args: { path: '/w/a' } })).toBeNull();
    expect(parseLinkFrame({ ...ok, args: { limit: 5, ref: 'main' } })).toBeNull();
  });
  it('checks a git.res result by its op', () => {
    const res = (result: unknown) => ({ t: 'git.res', id: 'g-1', ok: true, result });
    expect(parseLinkFrame(res({ op: 'diff', file: { path: '/w/a' } }))).not.toBeNull();
    expect(parseLinkFrame(res({ op: 'diff', files: [] }))).toBeNull();
    expect(
      parseLinkFrame(res({ op: 'log', commits: [], layout: {}, hasMore: false, state: 'odd' })),
    ).toBeNull();
    expect(
      parseLinkFrame({
        t: 'git.res',
        id: 'g-1',
        ok: false,
        error: { code: 'refused', message: 'no' },
      }),
    ).not.toBeNull();
  });
});
