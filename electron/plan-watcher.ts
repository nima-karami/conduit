// Host-side live watcher for a project's `.conduit/plans/` directory. It exists for ONE reason:
// picking up an EXTERNAL (agent) edit to a plan document or its comments sidecar — `.conduit/` is
// out of the fs firehose (src/watch-filter.ts), so this is the only path such a change takes to
// the renderer, and the app's own writes are suppressed here via the shared `isSelfEcho`.
// Unlike notes-watcher.ts this is armed per OPENED PROJECT, so every root has its own watch.
// See docs/plans/2026-09-19-interactive-plan.plan.md Task 3.3.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSelfEcho } from '../src/board-watch';
import { commentsFingerprint, type PlanCommentsData } from '../src/plan-comments';
import { PLAN_SLUG_RE, planSlugFromPath } from '../src/plan-path';
import { contentHash } from '../src/review-marks';
import { ConduitDirWatch } from './conduit-dir-watch';
import { conduitDir, PLANS_DIR_NAME, readPlan, readPlanComments } from './conduit-fs';

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

export class PlanWatcher {
  private readonly roots = new Map<string, RootWatch>();
  private readonly lastWritten = new Map<string, string>();

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
    this.arm(projectRoot, entry);
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
    // Drop this root's fingerprints with it, so a re-open can never suppress a real edit made
    // while the project was closed.
    for (const key of [...this.lastWritten.keys()]) {
      if (key.startsWith(`${projectRoot}|`)) this.lastWritten.delete(key);
    }
  }

  /** Fingerprint of the file the app is about to write, so the imminent FS event is its own echo. */
  recordWrite(root: string, slug: string, file: PlanFileKind, fingerprint: string): void {
    this.lastWritten.set(`${root}|${slug}|${file}`, fingerprint);
  }

  stop(): void {
    for (const entry of this.roots.values()) this.teardown(entry);
    this.roots.clear();
    this.lastWritten.clear();
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
      // `settle` is async where notes-watcher.ts:35 is synchronous, so its rejection has nowhere
      // to go — and it calls the host's broadcast closure, whose throw would otherwise surface as
      // an unhandled rejection in the main process.
      () => {
        this.settle(root, entry).catch((err) => {
          console.warn('[plan-watcher] settle failed for', root, err);
        });
      },
      { subdir: PLANS_DIR_NAME },
    );
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
      if (isSelfEcho(this.lastWritten.get(`${root}|${ref.slug}|${ref.file}`), current)) continue;
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
