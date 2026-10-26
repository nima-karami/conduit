// Owns every role-brief file operation (docs/specs/2026-10-26-conduit-role-brief.md §2-§4;
// plan Contracts §role-brief-host). Brief IO on the spawn path is sync on purpose: it must sit
// inside term:start's synchronous block after the isAlive re-check (spec §4 race row).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../src/atomic-write';
import { adapterFor, type BriefSupport } from '../src/conduit-mcp/adapters';
import { batchGuarded } from '../src/launch-args';
import type { HostPlatform } from '../src/lsp-binary';
import type { HostToWebview } from '../src/protocol';
import {
  type BriefBannerReason,
  briefArgs,
  briefBanner,
  briefByteCount,
  type DecodedBrief,
  decodeBrief,
  decodeBriefText,
  planBriefSpawn,
} from '../src/role-brief';
import type { SessionManager } from '../src/session-manager';
import type {
  AgentBriefSource,
  AgentDefinition,
  BriefError,
  BriefRequest,
  BriefState,
  SpawnSpec,
} from '../src/types';
import type { Logger } from './logger';

export interface RoleBriefHostDeps {
  userData: string;
  agentBriefs: ReadonlyMap<string, AgentBriefSource>;
  mgr: Pick<SessionManager, 'get' | 'setBrief' | 'mintId'>;
  platform: HostPlatform;
  e2e: boolean;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export type BriefCreation =
  | { ok: true; id: string; brief: BriefState | undefined; rollback(): void }
  | { ok: false; error: BriefError };

type AgentPreview = Omit<
  Extract<HostToWebview, { type: 'brief:agentPreviewed' }>,
  'type' | 'requestId'
>;

export interface RoleBriefHost {
  supportFor(def: AgentDefinition | undefined): BriefSupport | null;
  beginCreate(i: {
    def: AgentDefinition;
    request: BriefRequest | undefined;
    dialog: boolean;
  }): BriefCreation;
  beginDuplicate(sourceId: string): {
    id: string;
    brief: BriefState | undefined;
    rollback(): void;
  };
  prepareSpawn(
    sessionId: string,
    def: AgentDefinition | undefined,
    spec: SpawnSpec,
  ): { spec: SpawnSpec; banners: string[]; commit(alive: boolean): void };
  onSessionDeleted(sessionId: string): Promise<void>;
  sweep(keepIds: ReadonlySet<string>): void;
  probe(p: string): Promise<{ ok: true; bytes: number } | { ok: false; error: BriefError }>;
  agentPreview(def: AgentDefinition | undefined): Promise<AgentPreview>;
}

const SANITIZE = /[^\w.-]/g;
const FIRST_LINE_MAX = 120;
const LOG_SCOPE = 'brief';

/** Same transform as scrollbackFileName, plus dot-only keys: unlike the `scrollback-` prefix there
 *  is no literal part here, so an id of `..` would otherwise name userData itself. */
function keyOf(id: string): string {
  return id.replace(SANITIZE, '_').replace(/^\.+$/, (dots) => '_'.repeat(dots.length));
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function firstLineOf(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line === undefined ? undefined : line.slice(0, FIRST_LINE_MAX);
}

export function createRoleBriefHost(deps: RoleBriefHostDeps): RoleBriefHost {
  const { userData, agentBriefs, mgr, platform, e2e, log } = deps;
  const storeDir = path.join(userData, 'brief-store');
  const exposedRoot = path.join(userData, 'briefs');
  const canonicalOf = (id: string) => path.join(storeDir, `${keyOf(id)}.md`);
  const briefDirOf = (id: string) => path.join(exposedRoot, keyOf(id));

  /** Banners owed to a session whose brief was dropped before it had a launch (spec §2.2). */
  const queued = new Map<string, string[]>();
  const queue = (id: string, reason: BriefBannerReason) => {
    const list = queued.get(id) ?? [];
    list.push(briefBanner(reason));
    queued.set(id, list);
  };
  const drain = (id: string): string[] => {
    const banners = queued.get(id) ?? [];
    queued.delete(id);
    return banners;
  };

  const supportFor = (def: AgentDefinition | undefined): BriefSupport | null =>
    def ? (adapterFor(def, { e2e })?.brief ?? null) : null;

  const rmCanonical = (id: string) => fs.rmSync(canonicalOf(id), { force: true });

  /** A read failure is `brief-unreadable`; the decode rules are the pure core's. */
  function readSource(file: string): DecodedBrief | { ok: false; error: 'brief-unreadable' } {
    let bytes: Uint8Array;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return { ok: false, error: 'brief-unreadable' };
    }
    return decodeBrief(bytes);
  }

  function resolveText(
    request: BriefRequest | undefined,
    def: AgentDefinition,
  ): DecodedBrief | { ok: false; error: 'brief-unreadable' } {
    if (request?.kind === 'text') return decodeBriefText(request.text);
    if (request?.kind === 'file') return readSource(request.path);
    const source = agentBriefs.get(def.id);
    if (!source) return { ok: true, text: null };
    return source.kind === 'text' ? decodeBriefText(source.text) : readSource(source.path);
  }

  return {
    supportFor,

    beginCreate({ def, request, dialog }) {
      if (supportFor(def) === null || request?.kind === 'none') {
        return { ok: true, id: mgr.mintId(), brief: undefined, rollback() {} };
      }
      const decoded = resolveText(request, def);
      let error: BriefError | undefined = decoded.ok ? undefined : decoded.error;
      if (decoded.ok && decoded.text === null) {
        return { ok: true, id: mgr.mintId(), brief: undefined, rollback() {} };
      }
      if (error !== undefined && dialog) return { ok: false, error };

      const id = mgr.mintId();
      if (decoded.ok && decoded.text !== null) {
        try {
          fs.mkdirSync(storeDir, { recursive: true });
          atomicWriteFileSync(canonicalOf(id), decoded.text);
        } catch (err) {
          log.warn(LOG_SCOPE, 'brief write failed', { id, error: String(err) });
          rmCanonical(id);
          error = 'brief-io';
        }
      }
      if (error !== undefined) {
        if (dialog) return { ok: false, error };
        queue(id, { code: error });
        return { ok: true, id, brief: undefined, rollback: () => void queued.delete(id) };
      }
      return {
        ok: true,
        id,
        brief: 'pending',
        rollback: () => {
          rmCanonical(id);
          queued.delete(id);
        },
      };
    },

    beginDuplicate(sourceId) {
      const id = mgr.mintId();
      const rollback = () => {
        rmCanonical(id);
        queued.delete(id);
      };
      if (mgr.get(sourceId)?.brief === undefined) return { id, brief: undefined, rollback };
      try {
        fs.mkdirSync(storeDir, { recursive: true });
        fs.copyFileSync(canonicalOf(sourceId), canonicalOf(id));
      } catch (err) {
        log.warn(LOG_SCOPE, 'brief copy failed', { sourceId, id, error: String(err) });
        rmCanonical(id);
        queue(id, { code: 'copy-failed' });
        return { id, brief: undefined, rollback };
      }
      return { id, brief: 'pending', rollback };
    },

    prepareSpawn(sessionId, def, spec) {
      const briefDir = briefDirOf(sessionId);
      const briefFile = path.join(briefDir, 'brief.md');
      const canonical = canonicalOf(sessionId);
      const plan = planBriefSpawn({
        state: mgr.get(sessionId)?.brief,
        support: supportFor(def),
        canonicalExists: fs.existsSync(canonical),
        guarded: batchGuarded(platform, spec.command),
        briefDir,
        briefFile,
      });
      const banners: string[] = [];
      let out = spec;
      let sendPrompt = false;

      if (plan.kind === 'clear') {
        mgr.setBrief(sessionId, undefined);
        log.warn(LOG_SCOPE, 'role brief dropped at launch', { sessionId, drop: plan.drop.code });
        if (plan.banner) banners.push(briefBanner(plan.drop));
      } else if (plan.kind === 'args') {
        const support = supportFor(def);
        try {
          // Rebuilt every spawn so an agent's edits or stray files in the exposed dir never persist.
          fs.rmSync(briefDir, { recursive: true, force: true });
          fs.mkdirSync(briefDir, { recursive: true });
          fs.copyFileSync(canonical, briefFile);
          if (support) {
            out = {
              ...spec,
              args: [
                ...spec.args,
                ...briefArgs(support, { briefDir, briefFile, sendPrompt: plan.sendPrompt }),
              ],
            };
            sendPrompt = plan.sendPrompt;
          }
        } catch (err) {
          log.warn(LOG_SCOPE, 'brief rebuild failed', { sessionId, error: String(err) });
          banners.push(briefBanner({ code: 'rebuild-failed' }));
        }
      }
      banners.unshift(...drain(sessionId));

      return {
        spec: out,
        banners,
        commit(alive) {
          if (sendPrompt && alive) mgr.setBrief(sessionId, 'sent');
        },
      };
    },

    async onSessionDeleted(sessionId) {
      queued.delete(sessionId);
      for (const target of [canonicalOf(sessionId), briefDirOf(sessionId)]) {
        try {
          await fs.promises.rm(target, { recursive: true, force: true });
        } catch (err) {
          log.warn(LOG_SCOPE, 'brief delete failed', { sessionId, target, error: String(err) });
        }
      }
    },

    sweep(keepIds) {
      const keep = new Set([...keepIds].map(keyOf));
      for (const [dir, keyOfEntry] of [
        [storeDir, (n: string) => (n.endsWith('.md') ? n.slice(0, -3) : n)],
        [exposedRoot, (n: string) => n],
      ] as const) {
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch (err) {
          if (!isEnoent(err))
            log.warn(LOG_SCOPE, 'brief sweep list failed', { dir, error: String(err) });
          continue;
        }
        for (const name of names) {
          if (keep.has(keyOfEntry(name))) continue;
          try {
            fs.rmSync(path.join(dir, name), { recursive: true, force: true });
          } catch (err) {
            log.warn(LOG_SCOPE, 'brief sweep remove failed', { dir, name, error: String(err) });
          }
        }
      }
    },

    async probe(p) {
      let bytes: Uint8Array;
      try {
        bytes = await fs.promises.readFile(p);
      } catch {
        return { ok: false, error: 'brief-unreadable' };
      }
      const decoded = decodeBrief(bytes);
      if (!decoded.ok) return { ok: false, error: decoded.error };
      return { ok: true, bytes: decoded.text === null ? 0 : briefByteCount(decoded.text) };
    },

    async agentPreview(def) {
      const supported = supportFor(def) !== null;
      const source = def ? agentBriefs.get(def.id) : undefined;
      if (!source) return { supported, has: false };
      let decoded: DecodedBrief | { ok: false; error: 'brief-unreadable' };
      if (source.kind === 'text') decoded = decodeBriefText(source.text);
      else {
        try {
          decoded = decodeBrief(await fs.promises.readFile(source.path));
        } catch {
          decoded = { ok: false, error: 'brief-unreadable' };
        }
      }
      return {
        supported,
        has: true,
        ...(source.kind === 'file' ? { path: source.path } : {}),
        ...(decoded.ok
          ? decoded.text === null
            ? {}
            : { firstLine: firstLineOf(decoded.text) }
          : { error: decoded.error }),
      };
    },
  };
}
