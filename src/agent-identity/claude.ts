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
    const resumeFile =
      planned.source === 'resume' ? await fs.findTranscript(config, planned.id) : undefined;
    // Capture history before spawn so a rename immediately after SessionStart still counts.
    const resumeCursor = resumeFile
      ? await fs.readTitles(resumeFile, undefined, () => undefined)
      : undefined;
    if (launch.signal.aborted) return;
    let bound = false;
    let timer: NodeJS.Timeout | undefined;
    let registration: { file: string; token: object } | undefined;
    let unsubscribe: (() => void) | undefined;

    const stop = () => {
      clearTimeout(timer);
      unsubscribe?.();
      if (!registration) return;
      const { file, token } = registration;
      const listeners = registrations.get(file);
      listeners?.delete(token);
      if (listeners?.size === 0) {
        registrations.delete(file);
        for (const [nonce, writes] of echoes) {
          if (writes.file === file) echoes.delete(nonce);
        }
      }
    };
    launch.signal.addEventListener('abort', stop, { once: true });

    function watch(candidate: string, file: string, plan: PlannedConversation) {
      const token = {};
      const listeners = registrations.get(file) ?? new Set();
      listeners.add(token);
      registrations.set(file, listeners);
      registration = { file, token };
      let cursor: TranscriptCursor | undefined = resumeCursor;
      let lastTitle = plan.name;
      let hasRead = Boolean(cursor);

      async function poll() {
        try {
          const resolved = await fs.checkTranscript(projects, candidate, plan.id);
          if (resolved !== file) throw new Error('Claude transcript project moved');
          const previous = cursor;
          const records: { name: string; nonce: string | undefined }[] = [];
          cursor = await fs.readTitles(file, cursor, (line) => {
            const record = titleRecord(line);
            if (
              record?.type !== 'custom-title' ||
              record.sessionId !== plan.id ||
              typeof record.customTitle !== 'string'
            )
              return;
            records.push({
              name: record.customTitle,
              nonce: typeof record.conduitWrite === 'string' ? record.conduitWrite : undefined,
            });
          });
          const replaced =
            hasRead &&
            (!previous ||
              previous.inode !== cursor.inode ||
              previous.device !== cursor.device ||
              cursor.offset < previous.offset ||
              cursor.restarted);
          hasRead = true;
          for (const [index, { name, nonce }] of records.entries()) {
            if (launch.signal.aborted) return;
            const write = nonce ? echoes.get(nonce) : undefined;
            const echo = write?.file === file ? write : undefined;
            if (echo && nonce) echoes.delete(nonce);
            const effective = !replaced || index === records.length - 1;
            const changed = effective && name !== lastTitle;
            if (effective) lastTitle = name;
            if (changed || echo) {
              observer.rename({
                conversationId: plan.id,
                name,
                source: 'native',
                ...(echo ? { echoRevision: echo.revision } : {}),
              });
            }
          }
        } catch (error) {
          if (isMissing(error)) cursor = undefined;
          else deps.onError?.(error);
        }
        if (!launch.signal.aborted) {
          timer = setTimeout(() => void poll(), POLL_MS);
          timer.unref();
        }
      }

      void poll();
    }

    unsubscribe = deps.subscribeSessionStart(launch, (ids, payload) => {
      if (
        bound ||
        launch.signal.aborted ||
        ids.generation !== launch.ids.generation ||
        ids.launchId !== launch.ids.launchId ||
        !payload ||
        typeof payload !== 'object'
      )
        return;
      const hook = payload as {
        session_id?: unknown;
        source?: unknown;
        transcript_path?: unknown;
      };
      if (
        hook.session_id !== planned.id ||
        hook.source !== planned.source ||
        typeof hook.transcript_path !== 'string' ||
        !path.isAbsolute(hook.transcript_path)
      )
        return;
      const candidate = path.normalize(hook.transcript_path);
      void fs
        .checkTranscript(projects, candidate, planned.id)
        .then((file) => {
          if (bound || launch.signal.aborted || (resumeFile && file !== resumeFile)) return;
          bound = true;
          watch(candidate, file, planned);
          observer.bind(planned.id);
        })
        .catch((error: unknown) => deps.onError?.(error));
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
