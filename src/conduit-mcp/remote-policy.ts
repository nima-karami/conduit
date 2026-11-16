// A's copy of each machine's rules, its one draft per machine, and the push that sends a draft.
// see plan 2026-11-16-remote-ssh-rules, decisions 6 and 7

import type { RemotePolicyDoc, RemotePolicySnapshot } from '../contracts/remote-policy';
import { judgePersistedVersion, SERVER_FILE_VERSION } from '../contracts/session-identity';
import type { ActivityIo } from './activity-log';
import { serializePolicyFile, validateRemotePolicyDoc } from './policy-file';
import { createPolicyService, type PolicyService } from './policy-service';
import type { PolicyUiState } from './policy-types';
import type { NetworkPort, RemotePolicyPushResult, RemotePolicySink } from './remote-routing';
import type { RequestsIo } from './request-file-fs';
import { DEFAULT_TOOL_POLICY } from './tool-policy';
import { type Result, toolError } from './types';
import type { RemotePolicyStatus, RemotePolicyUi } from './ui-types';

interface RemotePolicyDraft {
  baseRev: number;
  doc: RemotePolicyDoc;
  editedAt: number;
}

type RemotePolicyEditError = 'no-copy' | 'busy';

interface RemotePolicyDeps {
  network(): Pick<NetworkPort, 'pushPolicy' | 'revokeRemoteGrant'> | undefined;
  draftsIo: RequestsIo;
  now(): number;
  newId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  warn(m: string, e?: unknown): void;
}

export interface RemotePolicy extends RemotePolicySink {
  /**
   * Runs one policy edit on the machine's rules as an in-memory PolicyService. The edit is kept as the
   * machine's draft, then pushed if it is up, or waits. Refused while a push is in flight.
   */
  edit<R extends { ok: boolean }>(
    machineId: string,
    op: (svc: PolicyService) => R,
  ): R | { ok: false; error: RemotePolicyEditError };
  revoke(machineId: string, grantId: string): Promise<Result<null>>;
  discard(machineId: string): void;
  reapply(machineId: string): Promise<void>;
  ui(names: (machineId: string) => string): RemotePolicyUi[];
  onChange(fn: () => void): () => void;
}

interface Entry {
  mirror: RemotePolicySnapshot | null;
  link: 'up' | 'down' | 'gone';
  draft: RemotePolicyDraft | null;
  status: RemotePolicyStatus;
  conflict: { rev: number; doc: RemotePolicyDoc } | null;
  refusal: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const noActivity: ActivityIo = {
  append: () => undefined,
  list: () => [],
  remove: () => undefined,
  readArgs: () => null,
  writeArgs: () => undefined,
};

const noWrite: RequestsIo = { read: () => null, write: async () => undefined };

type DraftsParse =
  | { ok: true; drafts: Map<string, RemotePolicyDraft> }
  | { ok: false; reason: 'corrupt' | 'newer' };

// A file this build cannot read is kept as it is: its drafts are shown as none, and nothing overwrites it.
function parseDrafts(text: string): DraftsParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (!isObj(raw)) return { ok: false, reason: 'corrupt' };
  const verdict = judgePersistedVersion('conduit-mcp/remote-policy.json', raw.version);
  if (verdict === 'newer') return { ok: false, reason: 'newer' };
  if (verdict === 'invalid' || !isObj(raw.drafts)) return { ok: false, reason: 'corrupt' };
  const drafts = new Map<string, RemotePolicyDraft>();
  for (const [machineId, d] of Object.entries(raw.drafts)) {
    if (!isObj(d) || typeof d.baseRev !== 'number' || !Number.isInteger(d.baseRev))
      return { ok: false, reason: 'corrupt' };
    if (d.baseRev < 0 || typeof d.editedAt !== 'number') return { ok: false, reason: 'corrupt' };
    const doc = validateRemotePolicyDoc(d.doc);
    if (!doc.ok) return { ok: false, reason: 'corrupt' };
    drafts.set(machineId, { baseRev: d.baseRev, doc: doc.doc, editedAt: d.editedAt });
  }
  return { ok: true, drafts };
}

export function createRemotePolicy(deps: RemotePolicyDeps): RemotePolicy {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let writable = true;

  const notify = (): void => {
    for (const fn of listeners) fn();
  };

  const entry = (machineId: string): Entry => {
    const found = entries.get(machineId);
    if (found !== undefined) return found;
    const fresh: Entry = {
      mirror: null,
      link: 'down',
      draft: null,
      status: 'applied',
      conflict: null,
      refusal: null,
    };
    entries.set(machineId, fresh);
    return fresh;
  };

  const persist = (): void => {
    if (!writable) return;
    const drafts: Record<string, RemotePolicyDraft> = {};
    for (const [machineId, e] of entries) if (e.draft !== null) drafts[machineId] = e.draft;
    const text = `${JSON.stringify(
      { version: SERVER_FILE_VERSION['conduit-mcp/remote-policy.json'], drafts },
      null,
      2,
    )}\n`;
    deps.draftsIo
      .write(text)
      .catch((e: unknown) => deps.warn('remote-policy.json could not be saved', e));
  };

  // The in-memory copy the edit ops and the UI read: the same PolicyService as the local rules, fed
  // a doc instead of a file. Its timers are cleared at once, so nothing outlives the read.
  const over = (doc: RemotePolicyDoc, rev: number): PolicyService => {
    const text = serializePolicyFile({
      version: 1,
      rev,
      profiles: doc.profiles,
      assignments: doc.assignments,
      overrides: [],
      migratedFrom: null,
      notes: { onScreenOnlyOffered: [] },
    });
    const svc = createPolicyService({
      policyIo: { read: () => text, write: async () => undefined },
      lastGoodIo: noWrite,
      grantsIo: noWrite,
      activityIo: noActivity,
      now: deps.now,
      newId: deps.newId,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      warn: deps.warn,
      legacy: () => ({ global: DEFAULT_TOOL_POLICY, byCli: {}, sessions: [] }),
      launchedCli: () => null,
      onChanged: () => undefined,
    });
    svc.start();
    return svc;
  };

  const uiOf = (doc: RemotePolicyDoc, rev: number): PolicyUiState => {
    const svc = over(doc, rev);
    const ui = svc.ui([]);
    void svc.stop();
    return ui;
  };

  const baseOf = (e: Entry): { rev: number; doc: RemotePolicyDoc } | null => {
    if (e.draft !== null) return { rev: e.draft.baseRev, doc: e.draft.doc };
    if (e.mirror !== null) return { rev: e.mirror.rev, doc: e.mirror.doc };
    return null;
  };

  const settlePush = (e: Entry, r: RemotePolicyPushResult): void => {
    if (r.ok) {
      e.draft = null;
      e.conflict = null;
      e.refusal = null;
      e.status = 'applied';
      persist();
    } else if (r.error.code === 'policy_conflict' && 'current' in r) {
      e.conflict = { rev: r.current.rev, doc: r.current.doc };
      e.status = 'conflict';
    } else if (r.error.code === 'peer_unreachable') {
      e.refusal = null;
      e.status = 'waiting';
    } else {
      e.refusal = r.error.message;
      e.status = 'refused';
    }
    notify();
  };

  // The draft is pushed as it is; a reply that did not arrive is never sent again by this path.
  const send = (machineId: string, e: Entry): Promise<void> => {
    if (e.draft === null) return Promise.resolve();
    e.status = 'pushing';
    e.refusal = null;
    notify();
    const net = deps.network();
    const sent = e.draft;
    const reply: Promise<RemotePolicyPushResult> =
      net === undefined
        ? Promise.resolve({
            ok: false,
            error: toolError('peer_unreachable', 'Conduit is not connected to the network'),
          })
        : net.pushPolicy(machineId, sent.baseRev, sent.doc);
    return reply.then((r) => settlePush(e, r));
  };

  const load = (): void => {
    let text: string | null;
    try {
      text = deps.draftsIo.read();
    } catch (e) {
      writable = false;
      deps.warn('remote-policy.json could not be read; drafts are not saved', e);
      return;
    }
    if (text === null) return;
    const parsed = parseDrafts(text);
    if (!parsed.ok) {
      writable = false;
      deps.warn(
        parsed.reason === 'newer'
          ? 'remote-policy.json is from a newer version; drafts are not saved'
          : 'remote-policy.json is unreadable; drafts are not saved',
      );
      return;
    }
    for (const [machineId, draft] of parsed.drafts) {
      const e = entry(machineId);
      e.draft = draft;
      e.status = 'waiting';
    }
  };

  load();

  return {
    apply(machineId, snap) {
      const e = entry(machineId);
      e.mirror = snap;
      e.link = 'up';
      if (e.draft === null) {
        e.status = 'applied';
        e.conflict = null;
        e.refusal = null;
      } else if (e.status !== 'pushing') {
        // The reconnect rule: a draft goes out only on the rev it was edited from.
        if (e.draft.baseRev === snap.rev) void send(machineId, e);
        else {
          e.status = 'conflict';
          e.conflict = { rev: snap.rev, doc: snap.doc };
        }
      }
      notify();
    },

    setLinkState(machineId, state) {
      const e = entry(machineId);
      e.link = state;
      if (state === 'gone') e.mirror = null;
      const held = e.status === 'pushing' || e.status === 'conflict';
      if (e.draft !== null && !held && (state === 'gone' || state === 'down')) {
        e.status = 'waiting';
      }
      notify();
    },

    edit(machineId, op) {
      const e = entries.get(machineId);
      const base = e === undefined ? null : baseOf(e);
      if (e === undefined || base === null) return { ok: false, error: 'no-copy' };
      if (e.status === 'pushing') return { ok: false, error: 'busy' };
      const svc = over(base.doc, base.rev);
      let r: ReturnType<typeof op>;
      let doc: RemotePolicyDoc;
      try {
        r = op(svc);
        doc = svc.remoteDoc().doc;
      } finally {
        void svc.stop();
      }
      if (!r.ok) return r;
      e.draft = { baseRev: base.rev, doc, editedAt: deps.now() };
      e.refusal = null;
      persist();
      if (e.status !== 'conflict') {
        if (e.link === 'up') void send(machineId, e);
        else e.status = 'waiting';
      }
      notify();
      return r;
    },

    async revoke(machineId, grantId) {
      const net = deps.network();
      if (net === undefined)
        return {
          ok: false,
          error: toolError('peer_unreachable', 'Conduit is not connected to the network'),
        };
      return net.revokeRemoteGrant(machineId, grantId);
    },

    discard(machineId) {
      const e = entries.get(machineId);
      if (e === undefined || e.status === 'pushing' || e.draft === null) return;
      e.draft = null;
      e.conflict = null;
      e.refusal = null;
      e.status = 'applied';
      persist();
      notify();
    },

    async reapply(machineId) {
      const e = entries.get(machineId);
      if (e === undefined || e.draft === null || e.conflict === null || e.status === 'pushing')
        return;
      e.draft = { ...e.draft, baseRev: e.conflict.rev };
      e.conflict = null;
      persist();
      await send(machineId, e);
    },

    ui(names) {
      const out: RemotePolicyUi[] = [];
      for (const [machineId, e] of entries) {
        const base = baseOf(e);
        if (base === null) continue;
        out.push({
          machineId,
          name: names(machineId),
          link: e.link,
          rev: e.mirror?.rev ?? null,
          status: e.status,
          refusal: e.refusal,
          policy: uiOf(base.doc, base.rev),
          conflict: e.conflict === null ? null : uiOf(e.conflict.doc, e.conflict.rev),
          grants: e.mirror?.grants ?? [],
        });
      }
      return out;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
