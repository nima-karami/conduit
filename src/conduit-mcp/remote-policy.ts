// A's copy of each machine's rules, its one draft per machine, and the push that sends a draft.
// see plan 2026-11-16-remote-ssh-rules, decisions 6 and 7

import type { RemotePolicyDoc, RemotePolicySnapshot } from '../contracts/remote-policy';
import { judgePersistedVersion, SERVER_FILE_VERSION } from '../contracts/session-identity';
import type { ActivityIo } from './activity-log';
import {
  serializePolicyFile,
  validatePolicyAssignment,
  validateRemotePolicyDoc,
} from './policy-file';
import type { PolicyIo } from './policy-file-fs';
import { createPolicyService, type PolicyService } from './policy-service';
import type { PolicyEditResult, PolicyUiState } from './policy-types';
import type { NetworkPort, RemotePolicyPushResult, RemotePolicySink } from './remote-routing';
import { DEFAULT_TOOL_POLICY } from './tool-policy';
import { type Result, toolError } from './types';
import type { RemotePolicyEdit, RemotePolicyStatus, RemotePolicyUi } from './ui-types';

interface RemotePolicyDraft {
  baseRev: number;
  doc: RemotePolicyDoc;
  editedAt: number;
}

export const REMOTE_POLICY_DRAFTS_MAX_BYTES = 16 * 1024 * 1024;

interface RemotePolicyDeps {
  network(): Pick<NetworkPort, 'pushPolicy' | 'revokeRemoteGrant'> | undefined;
  draftsIo: PolicyIo;
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
  ): R | PolicyEditResult;
  editFull(machineId: string, expectedToken: string, edit: RemotePolicyEdit): PolicyEditResult;
  revoke(machineId: string, grantId: string): Promise<Result<null>>;
  discard(machineId: string, expectedToken: string): PolicyEditResult;
  reapply(machineId: string, expectedToken: string): PolicyEditResult;
  retrySave(machineId: string, expectedToken: string): PolicyEditResult;
  ui(names: (machineId: string) => string): RemotePolicyUi[];
  onChange(fn: () => void): () => void;
}

interface Entry {
  editToken: string;
  epoch: number;
  fresh: boolean;
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
  read: () => '',
  list: () => [],
  remove: () => undefined,
  readArgs: () => null,
  writeArgs: () => undefined,
};

const noWrite: PolicyIo = { read: () => null, writeSync: () => true };

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
  let storeError: string | null = null;
  const notify = (): void => {
    for (const fn of listeners) fn();
  };
  const entry = (machineId: string): Entry => {
    const found = entries.get(machineId);
    if (found) return found;
    const fresh: Entry = {
      editToken: deps.newId(),
      epoch: 0,
      fresh: false,
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
  const draftsNow = (): Map<string, RemotePolicyDraft> =>
    new Map([...entries].flatMap(([id, e]) => (e.draft === null ? [] : [[id, e.draft] as const])));
  const persist = (drafts: Map<string, RemotePolicyDraft>): PolicyEditResult => {
    if (!writable) return { ok: false, error: 'read-only' };
    const text = `${JSON.stringify({ version: SERVER_FILE_VERSION['conduit-mcp/remote-policy.json'], drafts: Object.fromEntries(drafts) }, null, 2)}\n`;
    if (Buffer.byteLength(text) > REMOTE_POLICY_DRAFTS_MAX_BYTES) {
      storeError = 'Remote pending rules are too large to save';
      notify();
      return { ok: false, error: 'too-large' };
    }
    try {
      if (deps.draftsIo.writeSync(text) !== true)
        throw new Error('Remote pending rules writer did not complete synchronously');
      storeError = null;
      return { ok: true };
    } catch (error) {
      storeError = 'Remote pending rules could not be saved';
      deps.warn(storeError, error);
      notify();
      return { ok: false, error: 'save-failed' };
    }
  };
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
      policyIo: { read: () => text, writeSync: () => true },
      lastGoodIo: noWrite,
      grantsIo: noWrite,
      activityIo: noActivity,
      hasSession: () => false,
      peerKnown: () => null,
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

  const uiOf = (e: Entry, doc: RemotePolicyDoc, rev: number): PolicyUiState => {
    const svc = over(doc, rev);
    try {
      return { ...svc.ui([]), editToken: e.editToken, saveError: storeError, readOnly: !writable };
    } finally {
      void svc.stop();
    }
  };
  const baseOf = (e: Entry): { rev: number; doc: RemotePolicyDoc } | null =>
    e.draft !== null
      ? { rev: e.draft.baseRev, doc: e.draft.doc }
      : e.mirror === null
        ? null
        : { rev: e.mirror.rev, doc: e.mirror.doc };
  const signature = (e: Entry): string => JSON.stringify([baseOf(e)?.doc, e.conflict]);
  const rotateIfChanged = (e: Entry, before: string): void => {
    if (signature(e) !== before) e.editToken = deps.newId();
  };
  const equalDoc = (a: RemotePolicyDoc, b: RemotePolicyDoc): boolean =>
    JSON.stringify(a) === JSON.stringify(b);
  const send = (machineId: string, e: Entry): void => {
    const submitted = e.draft;
    if (submitted === null || e.status === 'pushing') return;
    const epoch = e.epoch;
    const conflict = e.conflict;
    e.status = 'pushing';
    e.refusal = null;
    notify();
    const current = () =>
      entries.get(machineId) === e &&
      e.epoch === epoch &&
      e.draft === submitted &&
      e.status === 'pushing' &&
      e.conflict === conflict;
    const settle = (result: RemotePolicyPushResult): void => {
      if (!current()) return;
      const before = signature(e);
      if (result.ok) {
        if (e.mirror === null || e.mirror.rev <= result.value.rev)
          e.mirror = {
            rev: result.value.rev,
            doc: structuredClone(submitted.doc),
            grants: e.mirror?.grants ?? [],
          };
        e.draft = null;
        e.conflict = null;
        e.refusal = null;
        e.status = 'applied';
        const saved = persist(draftsNow());
        if (!saved.ok)
          storeError =
            'Remote rules were applied, but their stale local pending copy could not be saved away';
      } else if (result.error.code === 'policy_conflict' && 'current' in result) {
        e.conflict = structuredClone(result.current);
        e.status = 'conflict';
      } else if (result.error.code === 'peer_unreachable') {
        e.refusal = null;
        e.status = 'waiting';
      } else {
        e.refusal = result.error.message;
        e.status = 'refused';
      }
      rotateIfChanged(e, before);
      notify();
    };
    void Promise.resolve()
      .then(() => {
        const network = deps.network();
        return network === undefined
          ? {
              ok: false as const,
              error: toolError('peer_unreachable', 'Conduit is not connected to the network'),
            }
          : network.pushPolicy(machineId, submitted.baseRev, structuredClone(submitted.doc));
      })
      .then(settle, (error: unknown) => {
        deps.warn('remote policy push failed', error);
        settle({
          ok: false,
          error: toolError(
            'policy_unavailable',
            error instanceof Error ? error.message : String(error),
          ),
        });
      });
  };
  const prepareEdit = <R extends { ok: boolean }>(
    machineId: string,
    op: (svc: PolicyService) => R,
  ): R | PolicyEditResult => {
    const e = entries.get(machineId);
    const base = e && baseOf(e);
    if (!e || !base) return { ok: false, error: 'no-copy' };
    if (!writable) return { ok: false, error: 'read-only' };
    if (e.status === 'pushing') return { ok: false, error: 'busy' };
    const svc = over(base.doc, base.rev);
    let result: R;
    let checked: ReturnType<typeof validateRemotePolicyDoc>;
    try {
      result = op(svc);
      checked = validateRemotePolicyDoc(svc.remoteDoc().doc);
    } finally {
      void svc.stop();
    }
    if (!result.ok) return result;
    if (!checked.ok)
      return {
        ok: false,
        error: checked.message.includes('too large') ? 'too-large' : 'invalid-value',
      };
    const draft = { baseRev: base.rev, doc: checked.doc, editedAt: deps.now() };
    const candidate = draftsNow();
    candidate.set(machineId, draft);
    const saved = persist(candidate);
    if (!saved.ok) return saved;
    e.draft = draft;
    e.refusal = null;
    e.editToken = deps.newId();
    if (e.status !== 'conflict') {
      e.status = 'waiting';
      if (e.link === 'up') send(machineId, e);
    }
    notify();
    return result;
  };
  const checkedEntry = (machineId: string, token: string): Entry | PolicyEditResult => {
    const e = entries.get(machineId);
    if (!e || baseOf(e) === null) return { ok: false, error: 'no-copy' };
    if (e.editToken !== token) return { ok: false, error: 'conflict' };
    if (!writable) return { ok: false, error: 'read-only' };
    if (e.status === 'pushing') return { ok: false, error: 'busy' };
    return e;
  };
  const load = (): void => {
    let text: string | null;
    try {
      text = deps.draftsIo.read();
    } catch (error) {
      writable = false;
      storeError = 'Remote pending rules could not be read';
      deps.warn(storeError, error);
      return;
    }
    if (text === null) return;
    if (Buffer.byteLength(text) > REMOTE_POLICY_DRAFTS_MAX_BYTES) {
      writable = false;
      storeError = 'Remote pending rules file is too large; it is read-only';
      deps.warn(storeError);
      return;
    }
    const parsed = parseDrafts(text);
    if (!parsed.ok) {
      writable = false;
      storeError =
        parsed.reason === 'newer'
          ? 'Remote pending rules are from a newer version; they are read-only'
          : 'Remote pending rules are unreadable; they are read-only';
      deps.warn(storeError);
      return;
    }
    for (const [id, draft] of parsed.drafts) {
      const e = entry(id);
      e.draft = draft;
      e.status = 'waiting';
    }
  };
  load();
  return {
    apply(machineId, snap) {
      const e = entry(machineId);
      if (e.fresh && e.mirror !== null && snap.rev < e.mirror.rev) return;
      const before = signature(e);
      const replaced = e.link === 'gone';
      if (e.link !== 'up') e.epoch++;
      e.mirror = structuredClone(snap);
      e.link = 'up';
      e.fresh = true;
      if (e.draft === null) {
        e.status = 'applied';
        e.conflict = null;
        e.refusal = null;
      } else if (e.status === 'pushing') {
        if (snap.rev > e.draft.baseRev && !equalDoc(snap.doc, e.draft.doc)) {
          e.conflict = { rev: snap.rev, doc: structuredClone(snap.doc) };
          e.status = 'conflict';
        }
      } else if (e.draft.baseRev === snap.rev) {
        e.conflict = null;
        send(machineId, e);
      } else {
        e.status = 'conflict';
        e.conflict = { rev: snap.rev, doc: structuredClone(snap.doc) };
      }
      rotateIfChanged(e, before);
      if (replaced) e.editToken = deps.newId();
      notify();
    },
    setLinkState(machineId, state) {
      const e = entry(machineId);
      if (e.link !== state) e.epoch++;
      e.link = state;
      if (state !== 'up') e.fresh = false;
      if (state === 'gone') {
        e.mirror = null;
        e.editToken = deps.newId();
      }
      if (e.draft !== null && state !== 'up' && e.status !== 'conflict') e.status = 'waiting';
      notify();
    },
    edit: prepareEdit,
    editFull(machineId, expectedToken, edit) {
      const e = checkedEntry(machineId, expectedToken);
      if ('ok' in e) return e;
      if (!isObj(edit)) return { ok: false, error: 'invalid-value' };
      if (edit.kind === 'assignment') {
        if (Object.keys(edit).some((key) => !['kind', 'point', 'assignment'].includes(key)))
          return { ok: false, error: 'invalid-value' };
        const assignment =
          edit.assignment === null
            ? { profileId: 'worker', exceptions: [], onScreenOnly: false }
            : edit.assignment;
        const checked = validatePolicyAssignment(edit.point, assignment);
        if (
          checked === null ||
          checked.point.kind === 'session' ||
          checked.assignment.exceptions.some((exception) => exception.scope.kind === 'session')
        )
          return { ok: false, error: 'invalid-value' };
        return prepareEdit(machineId, (svc) =>
          svc.saveAssignment(
            checked.point,
            edit.assignment === null ? null : checked.assignment,
            svc.ui([]).editToken,
          ),
        );
      }
      if (edit.kind === 'profile') {
        if (
          Object.keys(edit).some((key) => !['kind', 'profile'].includes(key)) ||
          !validateRemotePolicyDoc({ profiles: [edit.profile], assignments: [] }).ok
        )
          return { ok: false, error: 'invalid-value' };
        return prepareEdit(machineId, (svc) => svc.saveProfile(edit.profile, svc.ui([]).editToken));
      }
      if (
        edit.kind === 'delete-profile' &&
        Object.keys(edit).every((key) => ['kind', 'profileId', 'replacement'].includes(key)) &&
        typeof edit.profileId === 'string' &&
        typeof edit.replacement === 'string'
      )
        return prepareEdit(machineId, (svc) =>
          svc.deleteProfile(edit.profileId, edit.replacement, svc.ui([]).editToken),
        );
      return { ok: false, error: 'invalid-value' };
    },
    discard(machineId, expectedToken) {
      const e = checkedEntry(machineId, expectedToken);
      if ('ok' in e) return e;
      if (e.draft === null) return { ok: false, error: 'not-found' };
      const candidate = draftsNow();
      candidate.delete(machineId);
      const saved = persist(candidate);
      if (!saved.ok) return saved;
      e.draft = null;
      e.conflict = null;
      e.refusal = null;
      e.status = 'applied';
      e.editToken = deps.newId();
      notify();
      return { ok: true };
    },
    reapply(machineId, expectedToken) {
      const e = checkedEntry(machineId, expectedToken);
      if ('ok' in e) return e;
      if (e.draft === null || e.conflict === null) return { ok: false, error: 'not-found' };
      const draft = { ...e.draft, baseRev: e.conflict.rev };
      const candidate = draftsNow();
      candidate.set(machineId, draft);
      const saved = persist(candidate);
      if (!saved.ok) return saved;
      e.draft = draft;
      e.conflict = null;
      e.status = 'waiting';
      e.editToken = deps.newId();
      notify();
      if (e.link === 'up') send(machineId, e);
      return { ok: true };
    },
    retrySave(machineId, expectedToken) {
      const e = checkedEntry(machineId, expectedToken);
      if ('ok' in e) return e;
      const saved = persist(draftsNow());
      notify();
      return saved;
    },
    async revoke(machineId, grantId) {
      const net = deps.network();
      return net === undefined
        ? {
            ok: false,
            error: toolError('peer_unreachable', 'Conduit is not connected to the network'),
          }
        : net.revokeRemoteGrant(machineId, grantId);
    },
    ui(names) {
      return [...entries].flatMap(([id, e]) => {
        const base = baseOf(e);
        if (base === null) return [];
        return [
          {
            machineId: id,
            name: names(id),
            link: e.link,
            rev: e.mirror?.rev ?? null,
            status: e.status,
            refusal: e.refusal,
            policy: uiOf(e, base.doc, base.rev),
            conflict:
              e.conflict === null
                ? null
                : { ...uiOf(e, e.conflict.doc, e.conflict.rev), readOnly: true },
            grants: structuredClone(e.mirror?.grants ?? []),
          },
        ];
      });
    },
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
