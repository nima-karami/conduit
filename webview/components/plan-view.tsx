import * as monaco from 'monaco-editor';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { humanChanged, removedSinceBaseline } from '../../src/plan-baseline';
import { composePlan, type PlanBlock, splitPlan } from '../../src/plan-blocks';
import {
  newCommentId,
  type PlanComment,
  type PlanCommentPatch,
  reanchorComments,
} from '../../src/plan-comments';
import { buildPlanHandoff } from '../../src/plan-handoff';
import { PLANS_DIR, planSlugFromPath } from '../../src/plan-path';
import type { FileContentDTO } from '../../src/protocol';
import type { OpenDoc } from '../docs';
import { monacoOverflowHost } from '../monaco-overflow-host';
import { ensureTheme } from '../monaco-theme';
import {
  baselineFor,
  getPlanState,
  loadPlan,
  markPending,
  markViewed,
  patchPlanComments,
  resolveConflict,
  subscribePlans,
  writePlan,
} from '../plan-store';
import { useSettings } from '../settings';
import {
  getTerminalBusVersion,
  hasLiveTerminal,
  pasteToTerminal,
  subscribeTerminalBus,
} from '../terminal-bus';
import { pushToast } from '../toast-store';
import { getViewState, setViewState } from '../view-state-store';
import { PlanActionBar } from './plan-action-bar';
import { PlanDocContext } from './plan-code-block';
import { CommentComposer, PlanCommentsPanel } from './plan-comments-panel';
import { PlanEditor, type PlanEditorHandle } from './plan-editor';

/**
 * The document tab for `<root>/.conduit/plans/<slug>.md`: binds the plan store to the editor and
 * renders the states of spec docs/specs/2026-09-19-interactive-plan.md §8. Routed by PATH from
 * `DocBody`, so there is no `DocKind` for it.
 *
 * The editor speaks in bodies; the file is frontmatter + body, so every write recomposes the two.
 * The source view speaks in whole files and writes straight through.
 */

export interface PlanViewProps {
  doc: OpenDoc;
  root: string;
  sessionId?: string;
  /** The doc store's own read of the same path. Used ONLY by the load-failed state's "Open as
   *  text": the plan store holds no text for a file it refused, and `readFile` still returns the
   *  bytes (lossily decoded, capped at 2 MB) — which is what "show me the source" means here. */
  file?: FileContentDTO | undefined;
  onClose?: ((id: string) => void) | undefined;
}

const WRITE_DEBOUNCE_MS = 300;

const NO_HASHES: ReadonlySet<string> = new Set();
const NO_IDS: ReadonlySet<string> = new Set();

function copyPath(path: string): void {
  void navigator.clipboard?.writeText(path);
}

function PlanState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="plan">
      <div className="plan__state" role="status">
        <p>{message}</p>
        {children && <div className="plan__state-actions">{children}</div>}
      </div>
    </div>
  );
}

/**
 * The whole file in Monaco (spec §8 "source view"). Deliberately not `CodeViewer`: that one owns a
 * file through the doc store, and this text is the plan store's — every keystroke has to go back
 * through `writePlan` so the watcher's self-echo and the conflict flow keep working.
 */
function PlanSourceView({
  root,
  slug,
  text,
  readOnly,
}: {
  root: string;
  slug: string;
  text: string;
  readOnly: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  /** What we last sent to the store, so its echo does not reset the caret mid-typing. */
  const selfWriteRef = useRef<string | null>(null);
  const { settings } = useSettings();
  const textRef = useRef(text);
  textRef.current = text;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const fontSizeRef = useRef(settings.editorFontSize);
  fontSizeRef.current = settings.editorFontSize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const model = monaco.editor.createModel(textRef.current, 'markdown');
    modelRef.current = model;
    const editor = monaco.editor.create(host, {
      model,
      theme: ensureTheme(),
      readOnly: readOnlyRef.current,
      ariaLabel: 'Plan source',
      overflowWidgetsDomNode: monacoOverflowHost(),
      fixedOverflowWidgets: true,
      automaticLayout: true,
      minimap: { enabled: false },
      contextmenu: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: fontSizeRef.current,
      scrollBeyondLastLine: false,
      wordWrap: 'on',
    });
    editorRef.current = editor;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = model.onDidChangeContent(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const value = model.getValue();
        if (value === textRef.current) return;
        selfWriteRef.current = value;
        markPending(root, slug);
        writePlan(root, slug, value);
      }, WRITE_DEBOUNCE_MS);
    });

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      sub.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [root, slug]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    if (text === selfWriteRef.current) {
      selfWriteRef.current = null;
      return;
    }
    if (model.getValue() !== text) model.setValue(text);
  }, [text]);

  return <div className="plan__source-view" ref={hostRef} />;
}

export function PlanView({ doc, root, sessionId, file, onClose }: PlanViewProps) {
  const slug = planSlugFromPath(doc.path);

  useEffect(() => {
    if (slug) loadPlan(root, slug);
  }, [root, slug]);

  const state = useSyncExternalStore(
    subscribePlans,
    useCallback(() => (slug === null ? undefined : getPlanState(root, slug)), [root, slug]),
  );
  // A terminal can register or lose bracketed paste between renders, and neither is a state
  // update here — the bus's version counter is what re-renders the bar (terminal-bus.ts).
  useSyncExternalStore(subscribeTerminalBus, getTerminalBusVersion, getTerminalBusVersion);

  const editorRef = useRef<PlanEditorHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [armed, setArmed] = useState(false);
  const [everWrote, setEverWrote] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [gutter, setGutter] = useState<{ index: number; top: number } | null>(null);
  const [composerAt, setComposerAt] = useState<{ index: number; top: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const sourceRef = useRef(false);
  const [source, setSource] = useState(false);
  /** The comment patch in flight, so a `plan:error op:'comments'` can mark it and offer Retry. */
  const lastPatchRef = useRef<{ patch: PlanCommentPatch; ids: string[] } | null>(null);

  const disk = state?.disk ?? null;
  const split = useMemo(() => splitPlan(disk ?? ''), [disk]);
  const blocks = split.blocks;
  const agentChanged = state?.agentChanged ?? NO_HASHES;
  const commentsError = state?.commentsError ?? null;
  const saveError = state?.saveError ?? null;
  const readOnly = state?.readOnly ?? false;
  const conflict = state?.conflict ?? null;
  const failure = refused ?? saveError;
  const barSaveState: 'saved' | 'saving' | 'failed' | 'readonly' = readOnly
    ? 'readonly'
    : failure !== null
      ? 'failed'
      : armed || (state?.pendingWrite ?? false)
        ? 'saving'
        : 'saved';

  useLayoutEffect(() => {
    const stored = getViewState(`plan-source:${doc.id}`);
    const on = stored?.kind === 'planSource' ? stored.source : false;
    sourceRef.current = on;
    setSource(on);
  }, [doc.id]);

  const cancelWrite = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
  }, []);

  useEffect(() => cancelWrite, [cancelWrite]);

  const save = useCallback(
    (body: string): void => {
      if (slug === null) return;
      const current = getPlanState(root, slug);
      setEverWrote(true);
      writePlan(root, slug, composePlan(splitPlan(current?.disk ?? '').frontmatter, body));
    },
    [root, slug],
  );

  const handleBody = useCallback(
    (next: string): void => {
      if (slug === null) return;
      setRefused(null);
      markPending(root, slug);
      cancelWrite();
      setArmed(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setArmed(false);
        save(next);
      }, WRITE_DEBOUNCE_MS);
    },
    [root, slug, save, cancelWrite],
  );

  const handleBodyRefused = useCallback(
    (reason: string): void => {
      cancelWrite();
      setRefused(reason);
    },
    [cancelWrite],
  );

  /** A block's offset inside `.plan__body`, which is what the gutter and composer are placed in. */
  const topOf = useCallback((index: number): number | null => {
    const el = editorRef.current?.blockDom(index);
    const host = bodyRef.current;
    if (!el || !host) return null;
    return el.getBoundingClientRect().top - host.getBoundingClientRect().top;
  }, []);

  const handleBlockFocus = useCallback(
    (index: number | null): void => {
      setFocusIndex(index);
      // A null means the pointer left the document — often for the gutter button itself, which
      // sits outside it — so the affordance is dropped on leaving the pane, not on leaving the
      // text. Otherwise it would vanish under the pointer on its way to being clicked.
      if (index === null) return;
      const top = topOf(index);
      setGutter(top === null ? null : { index, top });
    },
    [topOf],
  );

  const openComposer = useCallback(
    (index: number): void => {
      const top = topOf(index);
      setComposerAt({ index, top: top ?? 0 });
      setGutter(null);
    },
    [topOf],
  );

  const sendPatch = useCallback(
    (patch: PlanCommentPatch, ids: string[]): void => {
      if (slug === null) return;
      lastPatchRef.current = { patch, ids };
      patchPlanComments(root, slug, patch);
    },
    [root, slug],
  );

  const addComment = useCallback(
    (index: number, text: string): void => {
      const target = getPlanState(root, slug ?? '');
      const at = splitPlan(target?.disk ?? '').blocks[index];
      if (!at) return;
      const comment: PlanComment = {
        id: newCommentId(Date.now()),
        author: 'human',
        text,
        anchor: { index, hash: at.hash, snippet: at.snippet },
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      sendPatch({ type: 'add', comment }, [comment.id]);
    },
    [root, slug, sendPatch],
  );

  const jumpTo = useCallback((index: number): void => {
    editorRef.current?.blockDom(index)?.scrollIntoView({ block: 'center' });
  }, []);

  const onNextChange = useCallback((): void => {
    if (slug === null) return;
    const current = getPlanState(root, slug);
    if (!current) return;
    const target = splitPlan(current.disk ?? '').blocks.find((b) =>
      current.agentChanged.has(b.hash),
    );
    if (!target) return;
    jumpTo(target.index);
    markViewed(root, slug, target.hash);
  }, [root, slug, jumpTo]);

  const toggleSource = useCallback((): void => {
    const next = !sourceRef.current;
    sourceRef.current = next;
    setSource(next);
    setGutter(null);
    setComposerAt(null);
    setViewState(`plan-source:${doc.id}`, { kind: 'planSource', source: next });
  }, [doc.id]);

  const live = sessionId !== undefined && hasLiveTerminal(sessionId);
  const openUnsent = useMemo(
    () => (state?.comments.comments ?? []).filter((c) => c.status === 'open' && !c.sentAt),
    [state?.comments.comments],
  );
  // Not memoised on `blocks`: Send replaces the baseline without touching the document, so a
  // cache keyed on the blocks alone would leave the bar saying there is still work to send.
  const changed = slug === null ? [] : humanChanged(blocks, baselineFor(root, slug));
  const pending = changed.length + openUnsent.length;

  const onSend = useCallback((): void => {
    if (slug === null) return;
    const current = getPlanState(root, slug);
    if (!current) return;
    const now = splitPlan(current.disk ?? '').blocks;
    const baseline = baselineFor(root, slug);
    const unsent = current.comments.comments.filter((c) => c.status === 'open' && !c.sentAt);
    const text = buildPlanHandoff({
      planPath: `${PLANS_DIR}/${slug}.md`,
      changed: humanChanged(now, baseline),
      removed: removedSinceBaseline(now, baseline),
      comments: reanchorComments(unsent, now),
      blocks: now,
    });
    const count = humanChanged(now, baseline).length + unsent.length;
    const stamp = (): void => {
      // Replaced wholesale — see the plan's §Settled decisions.
      sendPatch(
        {
          type: 'sent',
          ids: unsent.map((c) => c.id),
          baseline: { at: new Date().toISOString(), blockHashes: now.map((b) => b.hash) },
        },
        unsent.map((c) => c.id),
      );
      setAnnounce(`Sent ${count} item${count === 1 ? '' : 's'} to the agent`);
    };

    if (sessionId && pasteToTerminal(sessionId, text)) {
      stamp();
      pushToast({ message: `Sent the plan to ${sessionId}`, variant: 'info' });
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        stamp();
        pushToast({ message: 'Copied the plan handoff as markdown', variant: 'info' });
      })
      .catch(() => {
        pushToast({ message: 'Copy failed: the clipboard is unavailable.', variant: 'error' });
      });
  }, [root, slug, sessionId, sendPatch]);

  // A live region speaks on a text CHANGE, so a repeat Retry with the same outcome would set the
  // identical string, React would bail on the update, and the region would stay silent. Clearing it
  // in its own commit, with a paint before the text returns, makes every click audible.
  const announceFrameRef = useRef<number | null>(null);
  const reannounce = useCallback((message: string): void => {
    if (announceFrameRef.current !== null) cancelAnimationFrame(announceFrameRef.current);
    setAnnounce('');
    announceFrameRef.current = requestAnimationFrame(() => {
      announceFrameRef.current = null;
      setAnnounce(message);
    });
  }, []);

  useEffect(
    () => () => {
      if (announceFrameRef.current !== null) cancelAnimationFrame(announceFrameRef.current);
    },
    [],
  );

  // `resync` re-derives the body from the live document and calls `onBody` itself, so a refusal it
  // cannot clear leaves the failure — and its reason — standing. Saving `getBody()` here instead
  // would write the pre-refusal bytes and report Saved over what is on screen.
  const retrySave = useCallback((): void => {
    // Both outcomes are announced because BOTH are silent on screen: a `saveError` holds the bar at
    // `failed` across the whole round trip a successful resync starts, and a refusal it cannot
    // clear leaves the bar's reason standing unchanged.
    reannounce(
      editorRef.current?.resync() === true
        ? 'Retrying the save'
        : 'Retry failed: this plan still cannot be saved.',
    );
  }, [reannounce]);

  useEffect(() => {
    if (barSaveState === 'failed') setAnnounce(`Couldn't save: ${failure ?? 'unknown error'}`);
    else if (barSaveState === 'saved' && everWrote) setAnnounce('Saved');
  }, [barSaveState, failure, everWrote]);

  useEffect(() => {
    const n = agentChanged.size;
    if (n > 0) setAnnounce(`${n} block${n === 1 ? '' : 's'} changed by the agent`);
  }, [agentChanged]);

  // A scroll moves every block under the overlay, and the offsets it was placed with are taken
  // once. Scroll does not bubble, so the pane listens in the capture phase.
  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    const drop = (): void => {
      setGutter(null);
    };
    host.addEventListener('scroll', drop, true);
    return () => {
      host.removeEventListener('scroll', drop, true);
    };
  }, []);

  // A conflict pauses write-through, so the blocks must stop accepting input too — otherwise
  // Monaco and the diagram take edits that can never reach disk.
  const editorReadOnly = state !== undefined && (state.readOnly || state.conflict !== null);
  const docContext = useMemo(
    () => ({ root, slug: slug ?? '', readOnly: editorReadOnly }),
    [root, slug, editorReadOnly],
  );

  const anchored = useMemo(
    () => reanchorComments(state?.comments.comments ?? [], blocks),
    [state?.comments.comments, blocks],
  );
  const unsavedIds = useMemo(
    () => (commentsError === null ? NO_IDS : new Set(lastPatchRef.current?.ids ?? [])),
    [commentsError],
  );

  if (slug === null) {
    return (
      <PlanState message={`Can't open this plan: "${doc.title}" is not a usable plan name.`}>
        <button type="button" className="btn" onClick={() => copyPath(doc.path)}>
          Copy path
        </button>
      </PlanState>
    );
  }

  if (state === undefined || state.status === 'loading') {
    return (
      <div className="plan">
        <div className="plan__state" role="status" aria-busy="true" aria-label="Loading plan">
          <span className="plan__skel plan__skel--head" />
          <span className="plan__skel" />
          <span className="plan__skel" />
          <span className="plan__skel plan__skel--short" />
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    const reason = state.error ?? 'unknown error';
    // Spec §8: the load-failed state's one action is Open as text, so a corrupt or oversized
    // plan is never a pane you can only read an error off. It reuses the per-plan Source toggle
    // (persisted the same way), over the doc store's bytes rather than the plan store's, which
    // are the ones that failed to load.
    const raw = file?.content ?? '';
    if (source) {
      return (
        <div className="plan">
          <div className="plan__state plan__state--bar" role="status">
            <p>{`Can't open this plan: ${reason}`}</p>
            <button type="button" className="btn" onClick={toggleSource}>
              Hide source
            </button>
          </div>
          <div className="plan__body">
            {raw === '' ? (
              <div className="plan__state" role="status">
                {/* `binary` is only one of the reasons `content` comes back empty, and not the
                    motivating one: an over-cap plan returns its own `error` and no bytes. */}
                <p>
                  {file === undefined
                    ? 'Reading the file…'
                    : file.error
                      ? `There is no text to show: ${file.error}`
                      : 'There is no text to show: this file is binary.'}
                </p>
              </div>
            ) : (
              <PlanSourceView root={root} slug={slug} text={raw} readOnly />
            )}
          </div>
        </div>
      );
    }
    return (
      <PlanState message={`Can't open this plan: ${reason}`}>
        <button type="button" className="btn btn--primary" onClick={toggleSource}>
          Open as text
        </button>
        <button type="button" className="btn" onClick={() => copyPath(doc.path)}>
          Copy path
        </button>
      </PlanState>
    );
  }

  if (state.status === 'not-found') {
    return (
      <PlanState message="This plan was deleted.">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => writePlan(root, slug, `# ${slug}\n`)}
        >
          Recreate empty
        </button>
        <button type="button" className="btn" onClick={() => onClose?.(doc.id)}>
          Close
        </button>
      </PlanState>
    );
  }

  const keepMine = (): void => {
    cancelWrite();
    resolveConflict(
      root,
      slug,
      'mine',
      composePlan(split.frontmatter, editorRef.current?.getBody() ?? split.body),
    );
  };

  const sendBlockedReason =
    barSaveState === 'failed'
      ? 'Save failed'
      : commentsError !== null
        ? 'A comment is unsaved'
        : null;

  const labelOf = (block: PlanBlock | undefined): string =>
    block ? `Comment on ${block.kind} block: ${block.snippet}` : 'Comment on this block';

  return (
    <div className="plan">
      {conflict && (
        <div
          className="plan__conflict"
          role="alertdialog"
          aria-label="This plan changed on disk while you were editing"
        >
          <span>The agent changed this plan while you were editing it.</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              cancelWrite();
              resolveConflict(root, slug, 'theirs', '');
            }}
          >
            Load theirs
          </button>
          <button type="button" className="btn btn--primary" onClick={keepMine}>
            Keep mine
          </button>
        </div>
      )}
      {readOnly && (
        <div className="plan__state plan__state--bar" role="status">
          <p>This file is read-only.</p>
        </div>
      )}
      {/* The reason lives here; Retry is the bar's, so there is only ever one of it. */}
      {barSaveState === 'failed' && (
        <div className="plan__state plan__state--bar" role="status">
          <p>{`Couldn't save: ${failure}`}</p>
        </div>
      )}
      {agentChanged.size > 0 && (
        <span className="plan__changed">
          {agentChanged.size === 1
            ? '1 block changed by the agent'
            : `${agentChanged.size} blocks changed by the agent`}
        </span>
      )}

      <div
        className="plan__body"
        ref={bodyRef}
        onMouseLeave={() => setGutter(null)}
        onKeyDown={(e) => {
          if (e.key !== 'c' || e.ctrlKey || e.metaKey || e.altKey || focusIndex === null) return;
          // Prose is contenteditable and a code fence is Monaco, where `c` is a character; the
          // shortcut is for the blocks whose focus target takes no text (spec §9).
          const el = document.activeElement;
          if (
            el instanceof HTMLElement &&
            (el.isContentEditable ||
              el.tagName === 'INPUT' ||
              el.tagName === 'TEXTAREA' ||
              el.closest('.monaco-editor') !== null)
          )
            return;
          e.preventDefault();
          openComposer(focusIndex);
        }}
      >
        {source ? (
          <PlanSourceView root={root} slug={slug} text={disk ?? ''} readOnly={editorReadOnly} />
        ) : (
          <PlanDocContext.Provider value={docContext}>
            <PlanEditor
              ref={editorRef}
              body={split.body}
              readOnly={docContext.readOnly}
              fileReadOnly={readOnly && conflict === null}
              onBody={handleBody}
              onBodyRefused={handleBodyRefused}
              onBlockFocus={handleBlockFocus}
              agentChanged={agentChanged}
            />
          </PlanDocContext.Provider>
        )}

        {!source && gutter && composerAt === null && (
          <button
            type="button"
            className="plan__gutter"
            style={{ top: `${gutter.top}px` }}
            aria-label={labelOf(blocks[gutter.index])}
            title="Comment on this block"
            onClick={() => openComposer(gutter.index)}
          >
            +
          </button>
        )}
        {!source && composerAt && (
          <div className="plan__composer" style={{ top: `${composerAt.top}px` }}>
            <CommentComposer
              label={labelOf(blocks[composerAt.index])}
              onSave={(body) => {
                addComment(composerAt.index, body);
                setComposerAt(null);
              }}
              onCancel={() => setComposerAt(null)}
            />
          </div>
        )}

        <PlanCommentsPanel
          anchored={anchored}
          blocks={blocks}
          disabled={state.status !== 'ready'}
          unsavedIds={unsavedIds}
          onAdd={addComment}
          onEdit={(id, text) => sendPatch({ type: 'edit', id, text }, [id])}
          onResolve={(id, resolved) => sendPatch({ type: 'resolve', id, resolved }, [id])}
          onDelete={(id) => sendPatch({ type: 'delete', id }, [id])}
          onReattach={(id, index) => {
            const at = blocks[index];
            if (!at) return;
            sendPatch(
              { type: 'reattach', id, anchor: { index, hash: at.hash, snippet: at.snippet } },
              [id],
            );
          }}
          onJump={jumpTo}
          onRetry={() => {
            const last = lastPatchRef.current;
            if (last) sendPatch(last.patch, last.ids);
          }}
        />
      </div>

      <PlanActionBar
        pending={pending}
        live={live}
        sendBlockedReason={sendBlockedReason}
        saveState={barSaveState}
        source={source}
        nextCount={agentChanged.size}
        onSend={onSend}
        onToggleSource={toggleSource}
        onNextChange={onNextChange}
        onRetrySave={retrySave}
      />
      <span className="plan__live" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
