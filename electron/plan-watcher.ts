// Host-side live watcher for a project's `.conduit/plans/` directory. It exists for ONE reason:
// picking up an EXTERNAL (agent) edit to a plan document or its comments sidecar — `.conduit/` is
// out of the fs firehose (src/watch-filter.ts), so this is the only path such a change takes to
// the renderer. A settle emits only content that differs from what is already known for that
// file — what the renderer was last shown (a load, the app's own write, an emit), else the file
// as it was when the watch was armed — because an event is not proof of a change: FSEvents also
// reports writes made shortly BEFORE the watch was armed.
// Unlike notes-watcher.ts this is armed per OPENED PROJECT, so every root has its own watch.
// See docs/plans/2026-09-19-interactive-plan.plan.md Task 3.3.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { commentsFingerprint, type PlanCommentsData } from '../src/plan-comments';
import { PLAN_SLUG_RE, planSlugFromPath } from '../src/plan-path';
import { contentHash } from '../src/review-marks';
import { ConduitDirWatch } from './conduit-dir-watch';
import {
  conduitDir,
  PLANS_DIR_NAME,
  readPlan,
  readPlanComments,
  readPlanCommentsSync,
  readPlanMarkdownSync,
} from './conduit-fs';

/** `markdown` is only read for a `file: 'plan'` event; a sidecar event never reads the `.md`. */
export type OnPlanChange = (
  root: string,
  slug: string,
  file: 'plan' | 'comments',
  markdown: string | undefined,
  comments: PlanCommentsData,
) => void;

type PlanFileKind = 'plan' | 'comments';

interface PlanFileRef {
  slug: string;
  file: PlanFileKind;
}

interface RootWatch {
  watch: ConduitDirWatch;
  /** `${slug}|${file}` of every file an event named since the last settle. */
  touched: Set<string>;
  /** A platform that gave no filename tells us nothing — the whole dir is re-read on settle. */
  rescanAll: boolean;
}

const COMMENTS_SUFFIX = '.comments.json';

function plansDir(root: string): string {
  return path.join(conduitDir(root), PLANS_DIR_NAME);
}

/** A filename inside `.conduit/plans/` → the plan file it is, or null for anything else
 *  (`writeAtomic`'s `.<name>.<hex>.tmp`, a stray file, a slug `PLAN_SLUG_RE` rejects). */
function classify(root: string, filename: string): PlanFileRef | null {
  if (filename.endsWith('.tmp')) return null;
  if (filename.endsWith(COMMENTS_SUFFIX)) {
    const slug = filename.slice(0, -COMMENTS_SUFFIX.length);
    return PLAN_SLUG_RE.test(slug) ? { slug, file: 'comments' } : null;
  }
  const slug = planSlugFromPath(path.join(plansDir(root), filename));
  return slug ? { slug, file: 'plan' } : null;
}

function keyOf(root: string, ref: PlanFileRef): string {
  return `${root}|${ref.slug}|${ref.file}`;
}

interface Known {
  fingerprint: string;
  /** The renderer was handed this content (load, the app's own write, an emit). The plan store
   *  never evicts a document, so this outlives the watch; an arm-time disk read does not. */
  shown: boolean;
}

export class PlanWatcher {
  private readonly roots = new Map<string, RootWatch>();
  /** Per `${root}|${slug}|${file}`: the content already known for that file. */
  private readonly known = new Map<string, Known>();

  constructor(
    private readonly onChange: OnPlanChange,
    private readonly debounceMs = 250,
  ) {}

  /** Start watching `<projectRoot>/.conduit/plans/`. Idempotent per root. */
  watch(projectRoot: string): void {
    if (!projectRoot || this.roots.has(projectRoot)) return;
    const entry: RootWatch = {
      watch: new ConduitDirWatch(this.debounceMs, 'plan-watcher'),
      touched: new Set(),
      rescanAll: false,
    };
    this.roots.set(projectRoot, entry);
    this.recordBaseline(projectRoot, entry);
    this.arm(projectRoot, entry);
    // What the renderer still shows may have changed while nothing watched; that raised no event.
    if (entry.touched.size > 0) this.settleSoon(projectRoot, entry);
  }

  /**
   * Make the watched set exactly `openRoots`: arm the ones that are new, drop the ones no open
   * project holds any more. The caller has the live session list; this watcher only has what it
   * was last told, and a watch that is never dropped is an `fs.watch` handle (or a 2 s poll) held
   * for the app's lifetime. Idempotent for an unchanged list — a re-listed root is not restarted.
   */
  reconcile(openRoots: readonly string[]): void {
    const wanted = new Set(openRoots.filter((root) => root.length > 0));
    for (const root of [...this.roots.keys()]) if (!wanted.has(root)) this.unwatch(root);
    for (const root of wanted) this.watch(root);
  }

  unwatch(projectRoot: string): void {
    const entry = this.roots.get(projectRoot);
    if (!entry) return;
    this.roots.delete(projectRoot);
    this.teardown(entry);
    // A disk read is stale once nothing watches; what the renderer was shown stays true of it,
    // and is what a re-watch compares against.
    for (const [key, k] of [...this.known]) {
      if (!k.shown && key.startsWith(`${projectRoot}|`)) this.known.delete(key);
    }
  }

  /** Fingerprint of the file the app is about to write, so the imminent FS event is its own echo. */
  recordWrite(root: string, slug: string, file: PlanFileKind, fingerprint: string): void {
    this.recordShown(root, slug, file, fingerprint);
  }

  /** Fingerprint of content the host just sent the renderer for this file. */
  recordShown(root: string, slug: string, file: PlanFileKind, fingerprint: string): void {
    this.known.set(keyOf(root, { slug, file }), { fingerprint, shown: true });
  }

  stop(): void {
    for (const entry of this.roots.values()) this.teardown(entry);
    this.roots.clear();
    this.known.clear();
  }

  /**
   * Synchronous so the baseline is in place before any event the new watch delivers settles.
   * A file the renderer was shown keeps that baseline and is queued for a re-read instead.
   */
  private recordBaseline(root: string, entry: RootWatch): void {
    for (const [key, k] of this.known) {
      if (k.shown && key.startsWith(`${root}|`)) entry.touched.add(key.slice(root.length + 1));
    }
    let names: string[];
    try {
      names = fs.readdirSync(plansDir(root));
    } catch {
      return; // no plans dir yet: nothing is on disk, so whatever appears is news
    }
    for (const name of names) {
      const ref = classify(root, name);
      if (!ref || this.known.get(keyOf(root, ref))?.shown) continue;
      try {
        this.known.set(keyOf(root, ref), {
          fingerprint:
            ref.file === 'plan'
              ? contentHash(readPlanMarkdownSync(root, ref.slug) ?? '')
              : commentsFingerprint(readPlanCommentsSync(root, ref.slug)),
          shown: false,
        });
      } catch {
        // Unreadable now (oversized, not UTF-8, mid-write): nothing is known, so a later
        // readable version is news.
      }
    }
  }

  private teardown(entry: RootWatch): void {
    entry.watch.stop();
  }

  private arm(root: string, entry: RootWatch): void {
    entry.watch.start(
      root,
      (filename) => {
        if (filename === null) {
          entry.rescanAll = true;
          return true;
        }
        const ref = classify(root, filename);
        if (!ref) return false;
        entry.touched.add(`${ref.slug}|${ref.file}`);
        return true;
      },
      () => this.settleSoon(root, entry),
      { subdir: PLANS_DIR_NAME },
    );
  }

  // `settle` is async where notes-watcher.ts:35 is synchronous, so its rejection has nowhere to
  // go — and it calls the host's broadcast closure, whose throw would otherwise surface as an
  // unhandled rejection in the main process.
  private settleSoon(root: string, entry: RootWatch): void {
    this.settle(root, entry).catch((err) => {
      console.warn('[plan-watcher] settle failed for', root, err);
    });
  }

  private async settle(root: string, entry: RootWatch): Promise<void> {
    const refs = this.drain(root, entry);
    for (const ref of refs) {
      // Each file is read on its own path: a comment reaches the renderer even when the plan
      // beside it is unreadable, and the document read never runs for a sidecar event.
      let markdown: string | undefined;
      let comments: PlanCommentsData;
      try {
        if (ref.file === 'plan') {
          const doc = await readPlan(root, ref.slug);
          markdown = doc.markdown;
          comments = doc.comments;
        } else {
          comments = await readPlanComments(root, ref.slug);
        }
      } catch {
        // An unreadable plan (mid-write, locked, oversized) is skipped for this settle rather
        // than reported — the next write brings another event. Mirrors notes-watcher.ts:56-57.
        continue;
      }
      const current =
        ref.file === 'plan' ? contentHash(markdown ?? '') : commentsFingerprint(comments);
      const key = keyOf(root, ref);
      if (current === this.known.get(key)?.fingerprint) continue;
      // Unwatched during the awaited read: the re-watch replays against the unchanged baseline.
      if (this.roots.get(root) !== entry) return;
      this.known.set(key, { fingerprint: current, shown: true });
      this.onChange(root, ref.slug, ref.file, markdown, comments);
    }
  }

  private drain(root: string, entry: RootWatch): PlanFileRef[] {
    const refs = new Map<string, PlanFileRef>();
    for (const key of entry.touched) {
      const [slug, file] = key.split('|');
      if (slug && file) refs.set(key, { slug, file: file as PlanFileKind });
    }
    entry.touched.clear();
    if (entry.rescanAll) {
      entry.rescanAll = false;
      let names: string[] = [];
      try {
        names = fs.readdirSync(plansDir(root));
      } catch {
        names = [];
      }
      for (const name of names) {
        const ref = classify(root, name);
        if (ref) refs.set(`${ref.slug}|${ref.file}`, ref);
      }
    }
    return [...refs.values()];
  }
}
