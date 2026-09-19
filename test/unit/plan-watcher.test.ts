import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conduitDir,
  PLANS_DIR_NAME,
  writePlanCommentsFile,
  writePlanFile,
} from '../../electron/conduit-fs';
import { PlanWatcher } from '../../electron/plan-watcher';
import type { PlanComment, PlanCommentsData } from '../../src/plan-comments';
import { contentHash } from '../../src/review-marks';

interface PlanEvent {
  root: string;
  slug: string;
  file: 'plan' | 'comments';
  markdown: string | undefined;
  comments: PlanCommentsData;
}

interface Waiter {
  match: (e: PlanEvent) => boolean;
  settle: (e: PlanEvent) => void;
}

let events: PlanEvent[];
let waiters: Waiter[];
let roots: string[];
let watcher: PlanWatcher;

/** The 2 s existence poll, plus slack, in ms — how long "arms once the dir appears" has to wait. */
const POLL_WAIT_MS = 2600;
/** Long enough for a debounce (20 ms here) plus an fs.watch round trip to have happened. */
const QUIET_MS = 400;

const comment = (text: string): PlanComment => ({
  id: `c-${text}`,
  author: 'human',
  text,
  anchor: { index: 0, hash: 'abcd1234', snippet: 'intro' },
  status: 'open',
  createdAt: '2026-09-19T10:00:00.000Z',
});

const commentsData = (text: string): PlanCommentsData => ({
  version: 1,
  comments: [comment(text)],
});

function mkRoot(withPlansDir = true): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-watch-')));
  roots.push(root);
  if (withPlansDir) fs.mkdirSync(path.join(conduitDir(root), PLANS_DIR_NAME), { recursive: true });
  return root;
}

/** Resolve on the first matching event, or reject after `ms` — the watcher is debounced, so no polling. */
function nextEvent(match: (e: PlanEvent) => boolean, ms = 3000): Promise<PlanEvent> {
  const already = events.find(match);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no event')), ms);
    waiters.push({
      match,
      settle: (e) => {
        clearTimeout(timer);
        resolve(e);
      },
    });
  });
}

const quiet = (ms = QUIET_MS): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  events = [];
  waiters = [];
  roots = [];
  watcher = new PlanWatcher((root, slug, file, markdown, comments) => {
    const e: PlanEvent = { root, slug, file, markdown, comments };
    events.push(e);
    const hit = waiters.filter((w) => w.match(e));
    waiters = waiters.filter((w) => !w.match(e));
    for (const w of hit) w.settle(e);
  }, 20);
});

afterEach(() => {
  watcher.stop();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('PlanWatcher', () => {
  it('an external write to <slug>.md fires onChange with file plan and the markdown', async () => {
    const root = mkRoot();
    watcher.watch(root);
    const got = nextEvent((e) => e.slug === 'alpha');
    await writePlanFile(root, 'alpha', '# Alpha\n');
    const e = await got;
    expect(e.root).toBe(root);
    expect(e.file).toBe('plan');
    expect(e.markdown).toBe('# Alpha\n');
  });

  it('a write recorded via recordWrite before writing does not fire', async () => {
    const root = mkRoot();
    watcher.watch(root);
    const markdown = '# Ours\n';
    watcher.recordWrite(root, 'alpha', 'plan', contentHash(markdown));
    await writePlanFile(root, 'alpha', markdown);
    await quiet();
    expect(events).toEqual([]);

    // A genuine edit after our own write still gets through.
    const got = nextEvent((e) => e.slug === 'alpha');
    await writePlanFile(root, 'alpha', '# Theirs\n');
    expect((await got).markdown).toBe('# Theirs\n');
  });

  it('a comments-file write fires with file comments', async () => {
    const root = mkRoot();
    watcher.watch(root);
    const got = nextEvent((e) => e.file === 'comments');
    await writePlanCommentsFile(root, 'alpha', commentsData('hello'));
    const e = await got;
    expect(e.slug).toBe('alpha');
    expect(e.markdown).toBeUndefined();
    expect(e.comments.comments.map((c) => c.text)).toEqual(['hello']);
  });

  it('two roots watched at once each receive only their own events', async () => {
    const a = mkRoot();
    const b = mkRoot();
    watcher.watch(a);
    watcher.watch(b);

    const gotA = nextEvent((e) => e.root === a);
    await writePlanFile(a, 'alpha', '# A\n');
    expect((await gotA).slug).toBe('alpha');
    await quiet();
    expect(events.some((e) => e.root === b)).toBe(false);

    const gotB = nextEvent((e) => e.root === b);
    await writePlanFile(b, 'beta', '# B\n');
    expect((await gotB).slug).toBe('beta');
    expect(events.filter((e) => e.root === a).map((e) => e.slug)).toEqual(['alpha']);
    expect(events.filter((e) => e.root === b).map((e) => e.slug)).toEqual(['beta']);
  });

  it('watching before .conduit/plans exists arms once the dir appears', async () => {
    const root = mkRoot(false);
    watcher.watch(root);
    fs.mkdirSync(path.join(conduitDir(root), PLANS_DIR_NAME), { recursive: true });
    // The write has to land AFTER the poll arms the watch, or there is no fs event to catch.
    await quiet(POLL_WAIT_MS);
    const got = nextEvent((e) => e.slug === 'late', 5000);
    await writePlanFile(root, 'late', '# Late\n');
    expect((await got).markdown).toBe('# Late\n');
  });

  it('unwatch stops one root; stop clears every watch and poll interval', async () => {
    const a = mkRoot();
    const b = mkRoot();
    const c = mkRoot(false);
    watcher.watch(a);
    watcher.watch(b);
    watcher.watch(c);

    watcher.unwatch(a);
    await writePlanFile(a, 'alpha', '# A\n');
    const gotB = nextEvent((e) => e.root === b);
    await writePlanFile(b, 'beta', '# B\n');
    await gotB;
    expect(events.some((e) => e.root === a)).toBe(false);

    watcher.stop();
    await writePlanFile(b, 'beta', '# B again\n');
    // c was still polling for its plans dir when stop() ran; if the interval survived, it would
    // arm here and report the write below.
    fs.mkdirSync(path.join(conduitDir(c), PLANS_DIR_NAME), { recursive: true });
    await quiet(POLL_WAIT_MS);
    await writePlanFile(c, 'gamma', '# C\n');
    await quiet();
    expect(events.map((e) => e.root)).toEqual([b]);
  });
});
