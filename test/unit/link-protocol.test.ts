import { describe, expect, it } from 'vitest';
import {
  helloPlatform,
  type LinkFrame,
  type MonitorSession,
  type MonitorSnapshot,
  OWN_DEFAULT_CAPABILITIES,
  parseLinkFrame,
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
};

const FRAME_TYPES = Object.keys(SAMPLES) as LinkFrame['t'][];

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

  it.each(FRAME_TYPES)('rejects %s with any single top-level field of the wrong type', (t) => {
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
