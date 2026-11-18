// A's copy of each machine's rules, its one draft per machine, and the push that sends a draft.
// see plan 2026-11-16-remote-ssh-rules, decisions 6 and 7

import { createHash } from 'node:crypto';
import type { RemotePolicyDoc, RemotePolicySnapshot } from '../contracts/remote-policy';
import { judgePersistedVersion, SERVER_FILE_VERSION } from '../contracts/session-identity';
import type { ActivityIo } from './activity-log';
import {
  serializePolicyFile,
  validatePolicyAssignment,
  validateRemotePolicyDoc,
} from './policy-file';
import type { PolicyIo } from './policy-file-fs';
import { nativeProjection, stripNativeFields } from './policy-native';
import { createPolicyService, type PolicyService } from './policy-service';
import type { PolicyEditResult, PolicyUiState } from './policy-types';
import type { NetworkPort, RemotePolicyPushResult, RemotePolicySink } from './remote-routing';
import { DEFAULT_TOOL_POLICY } from './tool-policy';
import { type Result, toolError } from './types';
import type { RemotePolicyEdit, RemotePolicyStatus, RemotePolicyUi } from './ui-types';

interface NativeReview {
  version: 1;
  baseHash: string;
  desiredHash: string;
}

interface RemotePolicyDraft {
  baseRev: number;
  doc: RemotePolicyDoc;
  editedAt: number;
  nativeReview?: NativeReview;
}

export const REMOTE_POLICY_DRAFTS_MAX_BYTES = 16 * 1024 * 1024;

interface RemotePolicyDeps {
  network(): Pick<NetworkPort, 'pushPolicy' | 'revokeRemoteGrant' | 'nativeSupport'> | undefined;
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
  editFull(
    machineId: string,
    expectedToken: string,
    edit: RemotePolicyEdit,
    nativeConsent?: boolean,
  ): PolicyEditResult;
  revoke(machineId: string, grantId: string): Promise<Result<null>>;
  discard(machineId: string, expectedToken: string): PolicyEditResult;
  reapply(machineId: string, expectedToken: string, nativeConsent?: boolean): PolicyEditResult;
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
  nativeReviewRequired: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const HASH = /^[a-f0-9]{64}$/;
const revIsValid = (rev: unknown): rev is number =>
  typeof rev === 'number' && Number.isInteger(rev) && rev >= 0;

function parseReview(raw: unknown): NativeReview | undefined {
  if (!isObj(raw) || raw.version !== 1) return undefined;
  const { baseHash, desiredHash } = raw;
  if (typeof baseHash !== 'string' || !HASH.test(baseHash)) return undefined;
  if (typeof desiredHash !== 'string' || !HASH.test(desiredHash)) return undefined;
  return { version: 1, baseHash, desiredHash };
}

const hash = (projection: string): string => createHash('sha256').update(projection).digest('hex');
const reviewOf = (base: string, desired: string): NativeReview => ({
  version: 1,
  baseHash: hash(base),
  desiredHash: hash(desired),
});
const matchesReview = (proof: NativeReview | undefined, base: string, desired: string): boolean =>
  proof !== undefined && proof.baseHash === hash(base) && proof.desiredHash === hash(desired);

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
    if (
      !isObj(d) ||
      !revIsValid(d.baseRev) ||
      typeof d.editedAt !== 'number' ||
      !Number.isFinite(d.editedAt)
    )
      return { ok: false, reason: 'corrupt' };
    const doc = validateRemotePolicyDoc(d.doc);
    if (!doc.ok) return { ok: false, reason: 'corrupt' };
    const nativeReview = raw.version === 2 ? parseReview(d.nativeReview) : undefined;
    drafts.set(machineId, {
      baseRev: d.baseRev,
      doc: doc.doc,
      editedAt: d.editedAt,
      ...(nativeReview && { nativeReview }),
    });
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
      nativeReviewRequired: false,
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
      version: 2,
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
  const supportsNative = (machineId: string, e: Entry): boolean =>
    e.link === 'up' && deps.network()?.nativeSupport(machineId) === true;
  const signature = (e: Entry): string =>
    JSON.stringify([
      baseOf(e)?.doc,
      e.mirror && nativeProjection(e.mirror.doc),
      e.conflict,
      e.nativeReviewRequired,
      e.epoch,
    ]);
  const rotateIfChanged = (e: Entry, before: string): void => {
    if (signature(e) !== before) e.editToken = deps.newId();
  };
  const equalDoc = (a: RemotePolicyDoc, b: RemotePolicyDoc): boolean =>
    JSON.stringify(a) === JSON.stringify(b);
  const reviewBase = (e: Entry): RemotePolicySnapshot | null =>
    e.link === 'up' && e.fresh ? e.mirror : null;

  const clearReviewState = (e: Entry): void => {
    e.conflict = null;
    e.refusal = null;
    e.nativeReviewRequired = false;
  };
  const stale = (e: Entry, keepConflict = false): void => {
    e.fresh = false;
    const conflict = keepConflict && e.status === 'conflict' ? e.conflict : null;
    clearReviewState(e);
    e.conflict = conflict;
    e.status = conflict ? 'conflict' : e.draft === null ? 'applied' : 'waiting';
  };
  const refuseReview = (e: Entry, mirror: RemotePolicySnapshot, supported: boolean): void => {
    e.nativeReviewRequired = true;
    e.conflict = { rev: mirror.rev, doc: mirror.doc };
    e.refusal = supported
      ? 'Review and confirm the native launch changes against the current rules.'
      : 'Update the receiving machine before sending native launch changes.';
    e.status = e.draft?.baseRev === mirror.rev ? 'refused' : 'conflict';
  };
  const wireFor = (
    e: Entry,
    draft: RemotePolicyDraft,
    mirror: RemotePolicySnapshot,
    supported: boolean,
  ): RemotePolicyDoc | null => {
    const current = nativeProjection(mirror.doc);
    const desired = nativeProjection(draft.doc);
    if (
      desired !== current &&
      (!supported || !matchesReview(draft.nativeReview, current, desired))
    ) {
      refuseReview(e, mirror, supported);
      return null;
    }
    if (draft.baseRev !== mirror.rev) {
      e.conflict = { rev: mirror.rev, doc: mirror.doc };
      e.status = 'conflict';
      return null;
    }
    if (supported) return draft.doc;
    const wire = stripNativeFields(draft.doc);
    if (nativeProjection(wire) !== current) {
      refuseReview(e, mirror, false);
      return null;
    }
    return wire;
  };

  const send = (machineId: string, e: Entry): void => {
    const submitted = e.draft;
    const base = reviewBase(e);
    if (submitted === null || base === null || e.status === 'pushing') return;
    const before = signature(e);
    clearReviewState(e);
    if (wireFor(e, submitted, base, supportsNative(machineId, e)) === null) {
      rotateIfChanged(e, before);
      return;
    }
    const epoch = e.epoch;
    e.status = 'pushing';
    const current = () =>
      entries.get(machineId) === e &&
      e.epoch === epoch &&
      e.draft === submitted &&
      e.status === 'pushing' &&
      e.fresh &&
      e.link === 'up';
    const settle = (result: RemotePolicyPushResult, wire: RemotePolicyDoc): void => {
      if (!current()) return;
      const before = signature(e);
      if (result.ok) {
        if (e.mirror === null || e.mirror.rev <= result.value.rev)
          e.mirror = {
            rev: result.value.rev,
            doc: structuredClone(wire),
            grants: e.mirror?.grants ?? [],
          };
        e.draft = null;
        clearReviewState(e);
        e.status = 'applied';
        const saved = persist(draftsNow());
        if (!saved.ok)
          storeError =
            'Remote rules were applied, but their stale local pending copy could not be saved away';
      } else if (result.error.code === 'policy_conflict' && 'current' in result) {
        const checked = validateRemotePolicyDoc(result.current.doc);
        if (!revIsValid(result.current.rev) || !checked.ok) {
          stale(e);
          e.refusal = 'The receiving machine sent unreadable rules.';
        } else {
          if (e.mirror === null || result.current.rev >= e.mirror.rev)
            e.mirror = {
              rev: result.current.rev,
              doc: checked.doc,
              grants: e.mirror?.grants ?? [],
            };
          const mirror = e.mirror;
          clearReviewState(e);
          if (mirror && wireFor(e, submitted, mirror, supportsNative(machineId, e)) !== null) {
            e.conflict = { rev: mirror.rev, doc: mirror.doc };
            e.status = 'conflict';
          }
        }
      } else if (result.error.code === 'peer_unreachable') {
        e.refusal = null;
        e.status = 'waiting';
      } else {
        e.refusal = result.error.message;
        e.status = 'refused';
      }
      rotateIfChanged(e, before);
      if (!e.fresh) e.editToken = deps.newId();
      notify();
    };
    const failed = (error: unknown, wire: RemotePolicyDoc): void => {
      deps.warn('remote policy push failed', error);
      settle(
        {
          ok: false,
          error: toolError(
            'policy_unavailable',
            error instanceof Error ? error.message : String(error),
          ),
        },
        wire,
      );
    };
    void Promise.resolve().then(() => {
      if (!current()) return;
      const mirror = reviewBase(e);
      if (mirror === null) return;
      const network = deps.network();
      const wire = wireFor(e, submitted, mirror, network?.nativeSupport(machineId) === true);
      if (wire === null) {
        rotateIfChanged(e, before);
        notify();
        return;
      }
      if (network === undefined) {
        settle(
          {
            ok: false,
            error: toolError('peer_unreachable', 'Conduit is not connected to the network'),
          },
          wire,
        );
        return;
      }
      try {
        void network.pushPolicy(machineId, submitted.baseRev, structuredClone(wire)).then(
          (result) => settle(result, wire),
          (error: unknown) => failed(error, wire),
        );
      } catch (error) {
        failed(error, wire);
      }
    });
  };

  const publish = (machineId: string, e: Entry, draft: RemotePolicyDraft): PolicyEditResult => {
    const candidate = draftsNow();
    candidate.set(machineId, draft);
    const saved = persist(candidate);
    if (!saved.ok) return saved;
    const conflict = !e.fresh && e.conflict?.rev !== draft.baseRev ? e.conflict : null;
    e.draft = draft;
    e.editToken = deps.newId();
    clearReviewState(e);
    e.conflict = conflict;
    e.status = conflict ? 'conflict' : 'waiting';
    send(machineId, e);
    notify();
    return { ok: true };
  };

  const prepareEdit = <R extends { ok: boolean }>(
    machineId: string,
    op: (svc: PolicyService) => R,
    nativeConsent?: boolean,
  ): R | PolicyEditResult => {
    const e = entries.get(machineId);
    const base = e && baseOf(e);
    if (!e || !base) return { ok: false, error: 'no-copy' };
    if (!writable) return { ok: false, error: 'read-only' };
    if (e.status === 'pushing') return { ok: false, error: 'busy' };
    const epoch = e.epoch;
    const prior = e.draft;
    const mirror = e.mirror;
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
    if (
      entries.get(machineId) !== e ||
      e.epoch !== epoch ||
      e.draft !== prior ||
      e.mirror !== mirror
    )
      return { ok: false, error: 'conflict' };
    const draft: RemotePolicyDraft = { baseRev: base.rev, doc: checked.doc, editedAt: deps.now() };
    const desired = nativeProjection(draft.doc);
    if (desired !== nativeProjection(base.doc)) {
      const receiver = reviewBase(e);
      if (nativeConsent !== true || receiver === null || !supportsNative(machineId, e))
        return { ok: false, error: 'native-review-required' };
      draft.nativeReview = reviewOf(nativeProjection(receiver.doc), desired);
    } else if (
      mirror &&
      prior?.nativeReview &&
      matchesReview(prior.nativeReview, nativeProjection(mirror.doc), desired)
    ) {
      draft.nativeReview = prior.nativeReview;
    }
    const saved = publish(machineId, e, draft);
    return saved.ok ? result : saved;
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
      const checked = validateRemotePolicyDoc(snap.doc);
      if (!revIsValid(snap.rev) || !checked.ok) {
        stale(e);
        e.editToken = deps.newId();
        e.refusal = 'The receiving machine sent unreadable rules.';
        notify();
        return;
      }
      if (e.fresh && e.mirror !== null && snap.rev < e.mirror.rev) return;
      const before = signature(e);
      if (e.link !== 'up') e.epoch++;
      e.mirror = { rev: snap.rev, doc: checked.doc, grants: structuredClone(snap.grants) };
      e.link = 'up';
      e.fresh = true;
      if (e.draft === null) {
        e.status = 'applied';
        clearReviewState(e);
      } else if (e.status === 'pushing') {
        const desired = supportsNative(machineId, e) ? e.draft.doc : stripNativeFields(e.draft.doc);
        if (snap.rev > e.draft.baseRev && !equalDoc(checked.doc, desired)) {
          clearReviewState(e);
          wireFor(e, e.draft, e.mirror, supportsNative(machineId, e));
        }
      } else {
        send(machineId, e);
      }
      rotateIfChanged(e, before);
      notify();
    },
    setLinkState(machineId, state) {
      const e = entry(machineId);
      if (e.link === state) return;
      if (state === 'up') {
        e.epoch++;
        e.editToken = deps.newId();
      } else {
        stale(e, state === 'down');
      }
      e.link = state;
      if (state === 'gone') {
        e.mirror = null;
        e.editToken = deps.newId();
      }
      notify();
    },
    connectionReplaced(machineId) {
      const e = entry(machineId);
      e.epoch++;
      stale(e);
      e.editToken = deps.newId();
      notify();
    },
    edit: prepareEdit,
    editFull(machineId, expectedToken, edit, nativeConsent) {
      const e = checkedEntry(machineId, expectedToken);
      if ('ok' in e) return e;
      if (!isObj(edit) || (nativeConsent !== undefined && typeof nativeConsent !== 'boolean'))
        return { ok: false, error: 'invalid-value' };
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
        return prepareEdit(
          machineId,
          (svc) =>
            svc.saveAssignment(
              checked.point,
              edit.assignment === null ? null : checked.assignment,
              svc.ui([]).editToken,
              true,
            ),
          nativeConsent,
        );
      }
      if (edit.kind === 'profile') {
        if (
          Object.keys(edit).some((key) => !['kind', 'profile'].includes(key)) ||
          !validateRemotePolicyDoc({ profiles: [edit.profile], assignments: [] }).ok
        )
          return { ok: false, error: 'invalid-value' };
        return prepareEdit(
          machineId,
          (svc) => svc.saveProfile(edit.profile, svc.ui([]).editToken, true),
          nativeConsent,
        );
      }
      if (
        edit.kind === 'delete-profile' &&
        Object.keys(edit).every((key) => ['kind', 'profileId', 'replacement'].includes(key)) &&
        typeof edit.profileId === 'string' &&
        typeof edit.replacement === 'string'
      )
        return prepareEdit(
          machineId,
          (svc) => svc.deleteProfile(edit.profileId, edit.replacement, svc.ui([]).editToken, true),
          nativeConsent,
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
      clearReviewState(e);
      e.status = 'applied';
      e.editToken = deps.newId();
      notify();
      return { ok: true };
    },
    reapply(machineId, expectedToken, nativeConsent) {
      const e = checkedEntry(machineId, expectedToken);
      if ('ok' in e) return e;
      if (nativeConsent !== undefined && typeof nativeConsent !== 'boolean')
        return { ok: false, error: 'invalid-value' };
      const fresh = reviewBase(e);
      const mirror = fresh ?? e.conflict;
      if (e.draft === null || e.conflict === null || mirror === null)
        return { ok: false, error: 'not-found' };
      const draft = { ...e.draft, baseRev: mirror.rev };
      const base = nativeProjection(mirror.doc);
      const desired = nativeProjection(draft.doc);
      if (base !== desired) {
        if (fresh === null || !supportsNative(machineId, e))
          return { ok: false, error: 'native-review-required' };
        if (nativeConsent === true) draft.nativeReview = reviewOf(base, desired);
        else if (!matchesReview(draft.nativeReview, base, desired))
          return { ok: false, error: 'native-review-required' };
      } else {
        delete draft.nativeReview;
      }
      return publish(machineId, e, draft);
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
            nativeSupport: supportsNative(id, e),
            nativeReviewRequired: e.nativeReviewRequired,
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
