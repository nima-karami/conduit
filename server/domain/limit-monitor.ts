// Turns limit signals into episodes and resume jobs, and answers the Scheduler's pre-fire check.
// see docs/specs/2026-11-13-scheduler-auto-resume.md §2, §3 and rulings R1, R3, R4, R6, R8, R13
import type { CliKind } from '../../src/conduit-mcp/tool-policy';
import type { LimitSignal, RuleMatch, SignalSource } from '../../src/contracts/auto-resume';
import type {
  AutoResumeMode,
  Job,
  LimitEpisode,
  PreFireVerdict,
} from '../../src/contracts/scheduler';
import type { LimitOffer } from '../../src/protocol';
import type { Scheduler } from '../../src/scheduler';
import type { AppSettings } from '../../src/settings';

export const RULE_SCAN_INTERVAL_MS = 1_000;
const EPISODE_EXPIRY_MS = 24 * 60 * 60_000;
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;
const OFFER_SUPPRESS_MS = 30 * 60_000;
const SWEEP_MS = 10 * 60_000;
/** An in-flight delivery waits at most ECHO_MAX_MS (src/pty-writer.ts) before Enter. */
const OUTCOME_POLL_MS = 250;
const OUTCOME_TRIES = 40;
/** R13: how long busy must hold before a rules-only session counts as resumed. */
export const BUSY_RESUME_MS = 2_000;
/** R13: a busy session at fire time is re-checked after this much output quiet… */
export const FIRE_QUIET_MS = 3_000;
/** …for at most this long, after which it counts as resumed ("session kept working"). */
export const FIRE_DEFER_MAX_MS = 2 * 60_000;
/** R3: a rule-only episode counts as resumed after this many scans in a row without the match. */
const RULE_CLEAR_SCANS = 2;

export const ISSUE_RESET_UNKNOWN = 'Usage limit reached, reset time unknown';
export const ISSUE_AUTO_RESUME_OFF = 'Usage limit reached (auto-resume is off)';

type ResetWindows = Extract<LimitSignal, { kind: 'reset-info' }>['windows'];

export interface LimitMonitorDeps {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
  scheduler: Pick<
    Scheduler,
    'list' | 'armResume' | 'accept' | 'cancel' | 'resolveVerify' | 'recheck'
  >;
  settings(): Pick<
    AppSettings,
    'autoResume' | 'autoResumeMarginMs' | 'autoResumeMaxAttempts' | 'autoResumeMessage'
  >;
  /** The session's own override; undefined = inherit (R8). */
  sessionMode(sessionId: string): 'on' | 'off' | undefined;
  /** null for a shell or an unknown program: rules never scan those. */
  cliOf(sessionId: string): CliKind | null;
  isBusy(sessionId: string): boolean;
  screen(sessionId: string): Promise<readonly string[] | null>;
  scanRules(cli: CliKind, rows: readonly string[], now: number): RuleMatch | null;
  setResumeIssue(sessionId: string, reason: string | null): void;
  /** Episodes or the offer changed: persist and broadcast. */
  onChange(): void;
  log: {
    info(msg: string, data?: object): void;
    warn(msg: string, data?: object): void;
  };
}

export interface LimitMonitor {
  signal(s: LimitSignal): void;
  /** A structured adapter speaks for the session (Claude launched with hooks, Codex bound): R13. */
  onAdapterLive(sessionId: string): void;
  /** A new PTY started: which adapter speaks for it is decided again by this launch. */
  onLaunch(sessionId: string): void;
  /** The effective auto-resume mode may have changed (global setting or the session's override). */
  onModeChanged(): void;
  /** PTY output arrived: schedule a trailing-edge rules scan (R6). */
  onData(sessionId: string): void;
  /** Attention's busy flag for the session, read on every attention change (R3, R13). */
  onBusy(sessionId: string, busy: boolean): void;
  /** A keystroke from the window path (R4). */
  onHumanInput(sessionId: string): void;
  /** The session was closed or retired (R1). */
  onSessionClosed(sessionId: string): void;
  /** The PTY ended; only the agent quitting on its own ends the episode (R1). */
  onPtyExit(sessionId: string, reason: string): void;
  preFire(job: Job): PreFireVerdict;
  onJobFailed(job: Job, reason: string): void;
  answerOffer(sessionId: string, action: 'arm' | 'dismiss'): boolean;
  offer(): LimitOffer | null;
  episodes(): LimitEpisode[];
  load(episodes: readonly LimitEpisode[]): void;
  dispose(): void;
}

interface RuleScanState {
  timer: unknown;
  dirty: boolean;
  lastAt: number;
  running: boolean;
  /** Consecutive scans without the episode's rule matching (R3). */
  misses: number;
  /** Consecutive scans with no counting rule match at all. */
  absent: number;
}

const isStructured = (source: SignalSource): boolean => !source.startsWith('rule:');

export function createLimitMonitor(deps: LimitMonitorDeps): LimitMonitor {
  const episodes = new Map<string, LimitEpisode>();
  const resetInfo = new Map<string, ResetWindows>();
  /** Sessions that delivered a structured signal: their rules only supply a reset time (§3). */
  const structured = new Set<string>();
  const scans = new Map<string, RuleScanState>();
  /**
   * Rule matches are keyed by rule id + the matched reset TEXT, never the parsed instant: a clock
   * read after its time rolls to tomorrow, so the same notice would look new (review B4).
   */
  const resolvedRuleKey = new Map<string, string>();
  /** The key of the rule match the open episode came from or was last confirmed by. */
  const episodeRuleKey = new Map<string, string>();
  /** Per session: a scan has not matched since the last delivery started (§2 step 5). */
  const ruleAbsentSinceSend = new Map<string, boolean>();
  const ruleMessage = new Map<string, string>();
  /** An outcome that arrived while the resume was in flight, applied once it is verifying. */
  const pendingOutcome = new Map<
    string,
    {
      outcome: { kind: 'resumed' } | { kind: 'limited'; resetAt: number };
      tries: number;
      timer: unknown;
    }
  >();
  const dismissed = new Map<string, { resetAt: number | null; at: number }>();
  const busy = new Map<string, { on: boolean; timer: unknown; episodeId: string | null }>();
  /** R13: resume jobs deferred because the session was busy at fire time, by job id. */
  const deferred = new Map<
    string,
    { sessionId: string; nextAt: number; quiet: unknown; giveUp: unknown; expired: boolean }
  >();
  /** Sessions with a live proposed job whose offer is not shown yet (one offer slot). */
  const offerQueue: LimitOffer[] = [];
  let pendingOffer: LimitOffer | null = null;
  let seq = 0;

  const sweep = (): void => {
    const now = deps.now();
    for (const ep of episodes.values()) {
      if (ep.state === 'open' && ep.resetAt !== null && now > ep.resetAt + EPISODE_EXPIRY_MS) {
        closeEpisode(ep, 'expired', 'episode expired');
      }
    }
    sweepTimer = deps.setTimer(SWEEP_MS, sweep);
  };
  let sweepTimer: unknown = deps.setTimer(SWEEP_MS, sweep);

  const modeOf = (sessionId: string): AutoResumeMode =>
    deps.sessionMode(sessionId) ?? deps.settings().autoResume;

  const liveResumeJob = (sessionId: string): Job | undefined =>
    deps.scheduler
      .list()
      .find(
        (j) =>
          j.sessionId === sessionId &&
          j.trigger.kind === 'limit-reset' &&
          !['done', 'skipped', 'failed', 'cancelled'].includes(j.state),
      );

  const plausible = (resetAt: number | null | undefined, now: number): number | null => {
    if (resetAt == null || !Number.isFinite(resetAt)) return null;
    if (resetAt <= now || resetAt > now + MAX_RESET_AHEAD_MS) {
      deps.log.info('reset time out of range, treated as unknown', { resetAt, now });
      return null;
    }
    return resetAt;
  };

  /** §3 "Signals": the window at ≥100 % (the later one if several), else the soonest. */
  const fromResetInfo = (sessionId: string, now: number): number | null => {
    const windows = resetInfo.get(sessionId);
    if (!windows) return null;
    const live = windows.filter((w) => plausible(w.resetAt, now) !== null);
    const full = live.filter((w) => (w.usedPct ?? 0) >= 100);
    if (full.length > 0) return Math.max(...full.map((w) => w.resetAt));
    if (live.length === 0) return null;
    return Math.min(...live.map((w) => w.resetAt));
  };

  const setOffer = (offer: LimitOffer): void => {
    if (pendingOffer && pendingOffer.sessionId !== offer.sessionId) {
      const i = offerQueue.findIndex((o) => o.sessionId === offer.sessionId);
      if (i >= 0) offerQueue[i] = offer;
      else offerQueue.push(offer);
    } else pendingOffer = offer;
    deps.onChange();
  };

  /** The next queued offer whose session still has a proposed job. */
  const nextOffer = (): void => {
    pendingOffer = null;
    while (offerQueue.length > 0) {
      const o = offerQueue.shift();
      if (o && liveResumeJob(o.sessionId)?.state === 'proposed') {
        pendingOffer = o;
        return;
      }
    }
  };

  const dropOffer = (sessionId: string): void => {
    const i = offerQueue.findIndex((o) => o.sessionId === sessionId);
    if (i >= 0) offerQueue.splice(i, 1);
    if (pendingOffer?.sessionId === sessionId) nextOffer();
  };

  const closeEpisode = (ep: LimitEpisode, state: LimitEpisode['state'], why: string): void => {
    ep.state = state;
    deps.setResumeIssue(ep.sessionId, null);
    dropOffer(ep.sessionId);
    episodeRuleKey.delete(ep.sessionId);
    ruleMessage.delete(ep.sessionId);
    deps.log.info('episode ended', { sessionId: ep.sessionId, episodeId: ep.id, state, why });
    deps.onChange();
  };

  const armOrPropose = (ep: LimitEpisode, detail: string | undefined): void => {
    const mode = modeOf(ep.sessionId);
    if (ep.resetAt === null) {
      deps.setResumeIssue(ep.sessionId, ISSUE_RESET_UNKNOWN);
      return;
    }
    if (mode === 'off') {
      deps.setResumeIssue(ep.sessionId, ISSUE_AUTO_RESUME_OFF);
      return;
    }
    deps.setResumeIssue(ep.sessionId, null);
    const s = deps.settings();
    const existing = liveResumeJob(ep.sessionId);
    // A delivery in flight answers through resolveVerify, never a second arm (§2 step 5).
    if (existing && ['checking', 'sending', 'verifying'].includes(existing.state)) return;
    // A re-arm moves the fire time: a busy deferral of the old time no longer applies.
    if (existing) clearDeferral(existing.id);
    const proposed = mode === 'ask' && existing?.state !== 'armed' && existing?.state !== 'waiting';
    if (proposed) {
      const d = dismissed.get(ep.sessionId);
      if (d && d.resetAt === ep.resetAt && deps.now() - d.at < OFFER_SUPPRESS_MS) return;
    }
    const r = deps.scheduler.armResume({
      sessionId: ep.sessionId,
      episodeId: ep.id,
      resetAt: ep.resetAt,
      marginMs: s.autoResumeMarginMs,
      message: ruleMessage.get(ep.sessionId) ?? s.autoResumeMessage,
      maxAttempts: s.autoResumeMaxAttempts,
      proposed,
    });
    if (!r.ok) {
      deps.log.warn('resume job refused', { sessionId: ep.sessionId, error: r.error });
      deps.setResumeIssue(ep.sessionId, `Auto-resume could not be armed: ${r.error}`);
      return;
    }
    if (proposed) {
      setOffer({
        sessionId: ep.sessionId,
        resetAt: ep.resetAt,
        line: detail ?? 'Usage limit reached',
      });
    }
  };

  const setRuleKey = (sessionId: string, key: string): void => {
    episodeRuleKey.set(sessionId, key);
    const ep = episodes.get(sessionId);
    if (ep?.state === 'open' && ep.ruleKey !== key) {
      ep.ruleKey = key;
      deps.onChange();
    }
  };

  /** §2 step 5 outcome for a job still in checking/sending: held until it reaches verifying. */
  const applyWhenVerifying = (
    sessionId: string,
    outcome: { kind: 'resumed' } | { kind: 'limited'; resetAt: number },
  ): void => {
    const prev = pendingOutcome.get(sessionId);
    if (prev) deps.clearTimer(prev.timer);
    const attempt = (tries: number): void => {
      pendingOutcome.delete(sessionId);
      const job = liveResumeJob(sessionId);
      if (job?.state === 'verifying') {
        deps.scheduler.resolveVerify(sessionId, outcome);
        return;
      }
      if (!job || !['checking', 'sending'].includes(job.state) || tries >= OUTCOME_TRIES) return;
      pendingOutcome.set(sessionId, {
        outcome,
        tries,
        timer: deps.setTimer(OUTCOME_POLL_MS, () => attempt(tries + 1)),
      });
    };
    attempt(0);
  };

  const onLimited = (s: Extract<LimitSignal, { kind: 'limited' }>, ruleKey?: string): void => {
    const now = deps.now();
    const fromRule = !isStructured(s.source);
    if (!fromRule) structured.add(s.sessionId);
    const resetAt = plausible(s.resetAt, now) ?? fromResetInfo(s.sessionId, now);
    let ep = episodes.get(s.sessionId);
    const open = ep?.state === 'open' ? ep : undefined;

    if (fromRule) {
      if (!open && ruleKey !== undefined && resolvedRuleKey.get(s.sessionId) === ruleKey) return;
      // A structured adapter is speaking for this session: the rule may only fill in the time.
      if (structured.has(s.sessionId) && !(open && open.resetAt === null && resetAt !== null)) {
        return;
      }
    }

    const job = liveResumeJob(s.sessionId);
    if (open && job && ['checking', 'sending', 'verifying'].includes(job.state)) {
      // §2 step 5. A notice lingering on screen after delivery is not "limited again": a rule
      // counts only when its notice came back (absent since the send) or changed.
      if (fromRule) {
        const back = ruleAbsentSinceSend.get(s.sessionId) === true;
        const changed = ruleKey !== undefined && ruleKey !== episodeRuleKey.get(s.sessionId);
        if (!back && !changed) return;
        if (ruleKey !== undefined) setRuleKey(s.sessionId, ruleKey);
        ruleAbsentSinceSend.set(s.sessionId, false);
      }
      const next = resetAt ?? open.resetAt;
      if (next === null) {
        deps.scheduler.cancel(job.id, 'still limited, reset time unknown');
        deps.setResumeIssue(s.sessionId, ISSUE_RESET_UNKNOWN);
        return;
      }
      open.resetAt = Math.max(next, now);
      deps.onChange();
      applyWhenVerifying(s.sessionId, { kind: 'limited', resetAt: open.resetAt });
      return;
    }

    if (open) {
      // The same notice redrawn (or re-read after its clock rolled over) changes nothing: only a
      // new notice may move the reset (spec §4 "Same notice redrawn"; review round 2 B1).
      if (fromRule && ruleKey !== undefined && ruleKey === episodeRuleKey.get(s.sessionId)) {
        if (open.resetAt === null) deps.setResumeIssue(s.sessionId, ISSUE_RESET_UNKNOWN);
        return;
      }
      if (fromRule && ruleKey !== undefined) setRuleKey(s.sessionId, ruleKey);
      const upgraded = fromRule ? open.source : s.source;
      const nextReset = resetAt ?? open.resetAt;
      if (upgraded === open.source && nextReset === open.resetAt) {
        if (open.resetAt === null) deps.setResumeIssue(s.sessionId, ISSUE_RESET_UNKNOWN);
        return;
      }
      const resetChanged = nextReset !== open.resetAt;
      open.source = upgraded;
      open.resetAt = nextReset;
      deps.onChange();
      if (resetChanged) armOrPropose(open, s.detail);
      return;
    }

    ep = {
      id: `ep-${now.toString(36)}-${(seq++).toString(36)}`,
      sessionId: s.sessionId,
      cli: deps.cliOf(s.sessionId) ?? 'other',
      startedAt: s.at,
      resetAt,
      source: s.source,
      state: 'open',
    };
    episodes.set(s.sessionId, ep);
    if (fromRule && ruleKey !== undefined) setRuleKey(s.sessionId, ruleKey);
    const st = scans.get(s.sessionId);
    if (st) st.misses = 0;
    deps.log.info('episode opened', {
      sessionId: s.sessionId,
      episodeId: ep.id,
      resetAt,
      source: s.source,
    });
    deps.onChange();
    armOrPropose(ep, s.detail);
  };

  const onResetInfo = (s: Extract<LimitSignal, { kind: 'reset-info' }>): void => {
    structured.add(s.sessionId);
    resetInfo.set(s.sessionId, s.windows);
    const open = episodes.get(s.sessionId);
    if (open?.state !== 'open' || open.resetAt !== null) return;
    const resetAt = fromResetInfo(s.sessionId, deps.now());
    if (resetAt === null) return;
    open.resetAt = resetAt;
    deps.onChange();
    armOrPropose(open, undefined);
  };

  const onResumed = (s: Extract<LimitSignal, { kind: 'resumed' }>): void => {
    if (isStructured(s.source) && s.source !== 'attention' && s.source !== 'human-input') {
      structured.add(s.sessionId);
    }
    const job = liveResumeJob(s.sessionId);
    if (job && ['checking', 'sending', 'verifying'].includes(job.state))
      applyWhenVerifying(s.sessionId, { kind: 'resumed' });
    const open = episodes.get(s.sessionId);
    if (open?.state !== 'open') return;
    const key = episodeRuleKey.get(s.sessionId);
    if (key !== undefined) resolvedRuleKey.set(s.sessionId, key);
    if (job?.state === 'proposed') deps.scheduler.cancel(job.id, 'already resumed');
    closeEpisode(open, 'resumed', `resumed by ${s.by} (${s.source})`);
  };

  const scanNow = async (sessionId: string, st: RuleScanState): Promise<void> => {
    const cli = deps.cliOf(sessionId);
    if (cli === null) return;
    st.running = true;
    st.dirty = false;
    st.lastAt = deps.now();
    let rows: readonly string[] | null = null;
    try {
      rows = await deps.screen(sessionId);
    } catch (err) {
      deps.log.warn('rules scan: screen read failed', { sessionId, err: String(err) });
    }
    st.running = false;
    // The session was closed or restarted while the screen was read: these rows are stale.
    if (scans.get(sessionId) !== st) return;
    if (rows === null) return;
    const now = deps.now();
    const match = deps.scanRules(cli, rows, now);
    const counts = match && (match.rule.kind === 'usage-limit' || match.rule.reset !== undefined);
    const open = episodes.get(sessionId);
    if (counts && match) {
      st.misses = 0;
      st.absent = 0;
      const structuredNow = structured.has(sessionId);
      if (match.rule.message && !structuredNow) ruleMessage.set(sessionId, match.rule.message);
      onLimited(
        {
          kind: 'limited',
          sessionId,
          at: now,
          ...(match.resetAt !== null ? { resetAt: match.resetAt } : {}),
          source: `rule:${match.rule.id}`,
          detail: match.reason,
        },
        `${match.rule.id}@${match.resetText ?? ''}`,
      );
    } else if (counts === false || match === null) {
      ruleAbsentSinceSend.set(sessionId, true);
      st.absent++;
      // Gone for RULE_CLEAR_SCANS scans in a row (not one scan landing mid-redraw): the same text
      // later is a new limit.
      if (st.absent >= RULE_CLEAR_SCANS) resolvedRuleKey.delete(sessionId);
    }
    if (
      !(counts && match) &&
      open?.state === 'open' &&
      !isStructured(open.source) &&
      !structured.has(sessionId)
    ) {
      st.misses++;
      if (st.misses >= RULE_CLEAR_SCANS) {
        onResumed({ kind: 'resumed', sessionId, at: now, by: 'turn', source: open.source });
      }
    }
    if (st.dirty) schedule(sessionId, st);
  };

  const schedule = (sessionId: string, st: RuleScanState): void => {
    if (st.timer !== null || st.running) {
      st.dirty = true;
      return;
    }
    const wait = Math.max(0, st.lastAt + RULE_SCAN_INTERVAL_MS - deps.now());
    st.timer = deps.setTimer(wait, () => {
      st.timer = null;
      void scanNow(sessionId, st);
    });
  };

  const clearDeferral = (jobId: string): void => {
    const d = deferred.get(jobId);
    if (!d) return;
    if (d.quiet !== null) deps.clearTimer(d.quiet);
    if (d.giveUp !== null) deps.clearTimer(d.giveUp);
    deferred.delete(jobId);
  };

  const armQuiet = (jobId: string): void => {
    const d = deferred.get(jobId);
    if (!d) return;
    if (d.quiet !== null) deps.clearTimer(d.quiet);
    d.quiet = deps.setTimer(FIRE_QUIET_MS, () => {
      d.quiet = null;
      deps.scheduler.recheck(jobId);
    });
  };

  const defer = (job: Job): PreFireVerdict => {
    let d = deferred.get(job.id);
    if (!d) {
      d = {
        sessionId: job.sessionId,
        nextAt: job.nextAt,
        quiet: null,
        giveUp: null,
        expired: false,
      };
      deferred.set(job.id, d);
      const entry = d;
      d.giveUp = deps.setTimer(FIRE_DEFER_MAX_MS, () => {
        entry.giveUp = null;
        entry.expired = true;
        deps.scheduler.recheck(job.id);
      });
    }
    armQuiet(job.id);
    return { go: 'wait', reason: 'session busy' };
  };

  const forget = (sessionId: string): void => {
    for (const [jobId, d] of deferred) if (d.sessionId === sessionId) clearDeferral(jobId);
    const st = scans.get(sessionId);
    if (st?.timer) deps.clearTimer(st.timer);
    scans.delete(sessionId);
    resetInfo.delete(sessionId);
    structured.delete(sessionId);
    resolvedRuleKey.delete(sessionId);
    episodeRuleKey.delete(sessionId);
    ruleAbsentSinceSend.delete(sessionId);
    ruleMessage.delete(sessionId);
    dismissed.delete(sessionId);
    dropOffer(sessionId);
    const po = pendingOutcome.get(sessionId);
    if (po) deps.clearTimer(po.timer);
    pendingOutcome.delete(sessionId);
    const b = busy.get(sessionId);
    if (b?.timer) deps.clearTimer(b.timer);
    busy.delete(sessionId);
  };

  return {
    signal(s) {
      switch (s.kind) {
        case 'limited':
          onLimited(s);
          return;
        case 'reset-info':
          onResetInfo(s);
          return;
        case 'resumed':
          onResumed(s);
          return;
        case 'auto-resume-unavailable':
          structured.add(s.sessionId);
          deps.log.info("the CLI's own auto-resume stopped", { sessionId: s.sessionId });
          return;
      }
    },
    onAdapterLive(sessionId) {
      structured.add(sessionId);
    },
    onLaunch(sessionId) {
      structured.delete(sessionId);
    },
    onData(sessionId) {
      for (const [jobId, d] of deferred) if (d.sessionId === sessionId) armQuiet(jobId);
      if (deps.cliOf(sessionId) === null) return;
      let st = scans.get(sessionId);
      if (!st) {
        st = { timer: null, dirty: false, lastAt: 0, running: false, misses: 0, absent: 0 };
        scans.set(sessionId, st);
      }
      schedule(sessionId, st);
    },
    onBusy(sessionId, isBusy) {
      const st = busy.get(sessionId) ?? { on: false, timer: null, episodeId: null };
      busy.set(sessionId, st);
      if (st.on === isBusy) return;
      st.on = isBusy;
      if (st.timer !== null) deps.clearTimer(st.timer);
      st.timer = null;
      st.episodeId = null;
      // R13: only a rules-only session, only an edge AFTER its episode opened, held ≥ 2 s.
      const open = episodes.get(sessionId);
      if (!isBusy || structured.has(sessionId) || open?.state !== 'open') return;
      st.episodeId = open.id;
      st.timer = deps.setTimer(BUSY_RESUME_MS, () => {
        st.timer = null;
        const still = episodes.get(sessionId);
        if (!st.on || structured.has(sessionId) || still?.state !== 'open') return;
        if (still.id !== st.episodeId) return;
        onResumed({ kind: 'resumed', sessionId, at: deps.now(), by: 'turn', source: 'attention' });
      });
    },
    onHumanInput(sessionId) {
      if (episodes.get(sessionId)?.state !== 'open') return;
      onResumed({
        kind: 'resumed',
        sessionId,
        at: deps.now(),
        by: 'human-input',
        source: 'human-input',
      });
    },
    onSessionClosed(sessionId) {
      const ep = episodes.get(sessionId);
      forget(sessionId);
      if (!ep) return;
      if (ep.state === 'open') closeEpisode(ep, 'closed', 'session closed');
      episodes.delete(sessionId);
      deps.onChange();
    },
    onPtyExit(sessionId, reason) {
      // A dead PTY is not "still working": its busy deferral must not expire into a skip.
      for (const [jobId, d] of deferred) if (d.sessionId === sessionId) clearDeferral(jobId);
      if (reason !== 'exited') return;
      const ep = episodes.get(sessionId);
      if (ep?.state !== 'open') return;
      const job = liveResumeJob(sessionId);
      if (job) deps.scheduler.cancel(job.id, 'agent exited');
      closeEpisode(ep, 'closed', 'agent exited');
    },
    preFire(job) {
      if (job.trigger.kind !== 'limit-reset') return { go: true };
      const ep = episodes.get(job.sessionId);
      const d = deferred.get(job.id);
      if (!ep || ep.id !== job.trigger.episodeId) {
        clearDeferral(job.id);
        return { go: false, reason: 'episode closed' };
      }
      if (ep.state === 'resumed') {
        clearDeferral(job.id);
        return { go: false, reason: 'already resumed' };
      }
      if (ep.state !== 'open') {
        clearDeferral(job.id);
        return { go: false, reason: `episode ${ep.state}` };
      }
      if (modeOf(job.sessionId) === 'off') {
        clearDeferral(job.id);
        return { go: false, reason: 'auto-resume is off' };
      }
      if (d && d.nextAt !== job.nextAt) clearDeferral(job.id);
      if (d?.expired && deferred.has(job.id)) {
        clearDeferral(job.id);
        closeEpisode(ep, 'resumed', 'session kept working');
        return { go: false, reason: 'session kept working' };
      }
      if (deps.isBusy(job.sessionId)) return defer(job);
      clearDeferral(job.id);
      ruleAbsentSinceSend.set(job.sessionId, false);
      return { go: true };
    },
    onJobFailed(job, reason) {
      if (job.trigger.kind !== 'limit-reset') return;
      deps.setResumeIssue(job.sessionId, `Auto-resume failed: ${reason}`);
    },
    answerOffer(sessionId, action) {
      const job = liveResumeJob(sessionId);
      if (job?.state !== 'proposed') return false;
      dropOffer(sessionId);
      if (action === 'arm') {
        deps.scheduler.accept(job.id);
      } else {
        const resetAt = job.trigger.kind === 'limit-reset' ? job.trigger.resetAt : null;
        dismissed.set(sessionId, { resetAt, at: deps.now() });
        deps.scheduler.cancel(job.id, 'dismissed');
      }
      deps.onChange();
      return true;
    },
    offer: () => pendingOffer,
    episodes: () => [...episodes.values()],
    load(list) {
      for (const ep of list) {
        episodes.set(ep.sessionId, { ...ep });
        if (ep.state !== 'open') continue;
        if (ep.ruleKey !== undefined) episodeRuleKey.set(ep.sessionId, ep.ruleKey);
        // In-memory facts a restart lost (review B1 / S2): who speaks for the session, and why
        // it needs you.
        // Claude's hooks live in the CLI process, which survives a server restart; a Codex file
        // is only watched again once a launch binds it, so a restored Codex episode is rules-only
        // until then (known limitation, run report).
        if (ep.source === 'claude-hook' || ep.source === 'claude-statusline')
          structured.add(ep.sessionId);
        if (ep.resetAt === null) deps.setResumeIssue(ep.sessionId, ISSUE_RESET_UNKNOWN);
        else if (modeOf(ep.sessionId) === 'off')
          deps.setResumeIssue(ep.sessionId, ISSUE_AUTO_RESUME_OFF);
      }
    },
    onModeChanged() {
      for (const ep of episodes.values()) {
        if (ep.state !== 'open') continue;
        const job = liveResumeJob(ep.sessionId);
        if (modeOf(ep.sessionId) === 'off') {
          if (job && ['proposed', 'armed', 'waiting'].includes(job.state)) {
            clearDeferral(job.id);
            deps.scheduler.cancel(job.id, 'auto-resume turned off');
          }
          dropOffer(ep.sessionId);
          if (ep.resetAt !== null) deps.setResumeIssue(ep.sessionId, ISSUE_AUTO_RESUME_OFF);
        } else if (!job) {
          armOrPropose(ep, undefined);
        }
      }
      deps.onChange();
    },
    dispose() {
      deps.clearTimer(sweepTimer);
      for (const st of scans.values()) if (st.timer) deps.clearTimer(st.timer);
      for (const b of busy.values()) if (b.timer) deps.clearTimer(b.timer);
      for (const jobId of [...deferred.keys()]) clearDeferral(jobId);
      for (const po of pendingOutcome.values()) deps.clearTimer(po.timer);
      pendingOutcome.clear();
      scans.clear();
      busy.clear();
    },
  };
}
