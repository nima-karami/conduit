import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type {
  AgentIdentityAdapter,
  AgentIdentityLaunch,
  AgentIdentityObserver,
} from '../contracts/agent-identity';
import type { LaunchIds } from '../contracts/terminal-runtime';
import {
  appendTitle,
  checkTranscript,
  findTranscript,
  isClaudeId,
  isMissing,
  readTitles,
  type TranscriptCursor,
} from './claude-transcript';

interface ClaudeIdentityDeps {
  subscribeSessionStart(
    launch: AgentIdentityLaunch,
    onPayload: (ids: LaunchIds, payload: unknown) => void,
  ): () => void;
  fs?: {
    appendTitle: typeof appendTitle;
    checkTranscript: typeof checkTranscript;
    findTranscript: typeof findTranscript;
    readTitles: typeof readTitles;
  };
  onError?: (error: unknown) => void;
}

interface PlannedConversation {
  id: string;
  name: string;
  source: 'startup' | 'resume';
}

interface TitleRecord {
  type?: unknown;
  sessionId?: unknown;
  customTitle?: unknown;
  conduitWrite?: unknown;
}

function titleRecord(line: string): TitleRecord | undefined {
  if (!line.includes('"custom-title"')) return;
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object') return value;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

const POLL_MS = 250;

export function createClaudeIdentityAdapter(deps: ClaudeIdentityDeps): AgentIdentityAdapter {
  const fs = deps.fs ?? {
    appendTitle,
    checkTranscript,
    findTranscript,
    readTitles,
  };
  const plans = new WeakMap<AbortSignal, PlannedConversation>();
  const echoes = new Map<string, { file: string; revision: number }>();
  const registrations = new Map<string, Set<object>>();

  function plan(launch: AgentIdentityLaunch, conversation: PlannedConversation) {
    plans.set(launch.signal, conversation);
    const flag = conversation.source === 'startup' ? '--session-id' : '--resume';
    return {
      argv: [flag, conversation.id, '--name', conversation.name, ...launch.argv],
    };
  }

  async function observe(launch: AgentIdentityLaunch, observer: AgentIdentityObserver) {
    const planned = plans.get(launch.signal);
    if (!planned || launch.signal.aborted) return;
    const config = path.resolve(
      launch.scope.cwd,
      launch.env.CLAUDE_CONFIG_DIR || launch.scope.storageHome,
    );
    const projects = path.join(config, 'projects');
    const initialName = planned.name;
    const resumeFile =
      planned.source === 'resume' ? await fs.findTranscript(config, planned.id) : undefined;
    // Capture history before spawn so a rename immediately after SessionStart still counts.
    const resumeCursor = resumeFile
      ? await fs.readTitles(resumeFile, undefined, () => undefined)
      : undefined;
    if (launch.signal.aborted) return;
    let active: { id: string; stop: () => void } | undefined;
    let pending = Promise.resolve();
    let unsubscribe: (() => void) | undefined;

    const stop = () => {
      unsubscribe?.();
      active?.stop();
    };
    launch.signal.addEventListener('abort', stop, { once: true });

    function watch(candidate: string, file: string, id: string, initial: boolean) {
      const token = {};
      const listeners = registrations.get(file) ?? new Set();
      listeners.add(token);
      registrations.set(file, listeners);
      let running = true;
      let timer: NodeJS.Timeout | undefined;
      let cursor: TranscriptCursor | undefined = initial ? resumeCursor : undefined;
      let lastTitle = initial ? initialName : undefined;
      let hasRead = Boolean(cursor);

      async function poll() {
        try {
          const resolved = await fs.checkTranscript(projects, candidate, id);
          if (resolved !== file) throw new Error('Claude transcript project moved');
          const previous = cursor;
          const records: { name: string; nonce: string | undefined }[] = [];
          cursor = await fs.readTitles(file, cursor, (line) => {
            const record = titleRecord(line);
            if (
              record?.type !== 'custom-title' ||
              record.sessionId !== id ||
              typeof record.customTitle !== 'string'
            )
              return;
            records.push({
              name: record.customTitle,
              nonce: typeof record.conduitWrite === 'string' ? record.conduitWrite : undefined,
            });
          });
          const latestOnly =
            (!initial && !hasRead) ||
            (hasRead &&
              (!previous ||
                previous.inode !== cursor.inode ||
                previous.device !== cursor.device ||
                cursor.offset < previous.offset ||
                cursor.restarted));
          hasRead = true;
          for (const [index, { name, nonce }] of records.entries()) {
            if (!running || launch.signal.aborted) return;
            const write = nonce ? echoes.get(nonce) : undefined;
            const echo = write?.file === file ? write : undefined;
            if (echo && nonce) echoes.delete(nonce);
            const effective = !latestOnly || index === records.length - 1;
            const changed = effective && name !== lastTitle;
            if (effective) lastTitle = name;
            if (changed || echo) {
              observer.rename({
                conversationId: id,
                name,
                source: 'native',
                ...(echo ? { echoRevision: echo.revision } : {}),
              });
            }
          }
        } catch (error) {
          if (isMissing(error)) cursor = undefined;
          else if (running && !launch.signal.aborted) deps.onError?.(error);
        }
        if (running && !launch.signal.aborted) {
          timer = setTimeout(() => void poll(), POLL_MS);
          timer.unref();
        }
      }

      void poll();
      return () => {
        running = false;
        clearTimeout(timer);
        listeners.delete(token);
        if (listeners.size === 0) {
          registrations.delete(file);
          for (const [nonce, write] of echoes) {
            if (write.file === file) echoes.delete(nonce);
          }
        }
      };
    }

    unsubscribe = deps.subscribeSessionStart(launch, (ids, payload) => {
      if (
        launch.signal.aborted ||
        ids.generation !== launch.ids.generation ||
        ids.launchId !== launch.ids.launchId ||
        !payload ||
        typeof payload !== 'object'
      )
        return;
      const {
        session_id: id,
        source,
        transcript_path: transcript,
      } = payload as {
        session_id?: unknown;
        source?: unknown;
        transcript_path?: unknown;
      };
      if (!isClaudeId(id) || typeof transcript !== 'string' || !path.isAbsolute(transcript)) return;
      const candidate = path.normalize(transcript);

      // Keep hook order even when a later transcript path is quicker to validate.
      pending = pending
        .then(async () => {
          if (launch.signal.aborted || active?.id === id) return;
          const initial = active === undefined;
          if (
            initial
              ? id !== planned.id || source !== planned.source
              : source !== 'clear' && source !== 'resume'
          )
            return;
          const file = await fs.checkTranscript(projects, candidate, id);
          if (launch.signal.aborted || (initial && resumeFile && file !== resumeFile)) return;
          active?.stop();
          active = { id, stop: watch(candidate, file, id, initial) };
          observer.bind(id);
        })
        .catch((error: unknown) => {
          if (!launch.signal.aborted) deps.onError?.(error);
        });
    });
    if (launch.signal.aborted) stop();
  }

  return {
    id: 'claude',
    capabilities: { coupledNaming: true, exactResume: true },
    async fresh(launch, name) {
      return plan(launch, { id: randomUUID(), name, source: 'startup' });
    },
    async resume(launch, ref, name) {
      return plan(launch, { id: ref.conversationId, name, source: 'resume' });
    },
    async exists(ref) {
      try {
        return (await fs.findTranscript(ref.scope.storageHome, ref.conversationId))
          ? 'present'
          : 'missing';
      } catch (error) {
        return isMissing(error) ? 'missing' : 'unavailable';
      }
    },
    async setName(ref, name, revision) {
      const file = await fs.findTranscript(ref.scope.storageHome, ref.conversationId);
      if (!file) throw new Error('Claude transcript is missing');
      const nonce = randomUUID();
      if (registrations.has(file)) echoes.set(nonce, { file, revision });
      try {
        await fs.appendTitle(file, {
          type: 'custom-title',
          customTitle: name,
          sessionId: ref.conversationId,
          // Matching the title alone could misclassify a concurrent native rename.
          conduitWrite: nonce,
        });
      } catch (error) {
        echoes.delete(nonce);
        throw error;
      }
    },
    observe,
  };
}
