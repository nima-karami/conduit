import type { FSWatcher } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConduitDirWatch } from '../../electron/conduit-dir-watch';
import { conduitDir, PLANS_DIR_NAME, writePlanFile } from '../../electron/conduit-fs';
import { OpenFileWatcher } from '../../electron/open-file-watcher';
import { PlanWatcher } from '../../electron/plan-watcher';
import { delay, waitFor } from './watch-test-helpers';

type Listener = (event: string, filename: string | null) => void;
interface RealWatch {
  dir: string;
  cb: Listener;
  w: FSWatcher;
  close: ReturnType<typeof vi.spyOn>;
}

// Real watches (so real writes still arrive), recorded so a test can hand a callback the
// self-named event Windows produces for a deleted watched directory on any platform.
const watches: RealWatch[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const watch = (dir: string, ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as Listener;
    const w = (real.watch as (...a: unknown[]) => FSWatcher)(dir, ...rest);
    watches.push({ dir, cb, w, close: vi.spyOn(w, 'close') });
    return w;
  };
  return { ...real, default: { ...real, watch }, watch };
});

const vanish = (x: RealWatch) => {
  for (let i = 0; i < 1000; i++) x.cb('rename', `\\\\?\\${x.dir}`);
};

let tmp: string[];
const mkRoot = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-gone-')));
  tmp.push(root);
  return root;
};

beforeEach(() => {
  watches.length = 0;
  tmp = [];
});
afterEach(() => {
  for (const x of watches) x.w.close();
  for (const root of tmp) fs.rmSync(root, { recursive: true, force: true });
});

describe('ConduitDirWatch on a vanished .conduit/', () => {
  it('closes the watch once, never settles on the loop, and tells the owner', async () => {
    const root = mkRoot();
    fs.mkdirSync(conduitDir(root));
    const dw = new ConduitDirWatch(20);
    const onEvent = vi.fn(() => true);
    const onSettle = vi.fn();
    const onGone = vi.fn();
    dw.start(root, onEvent, onSettle, { onGone });
    expect(watches).toHaveLength(1);
    vanish(watches[0]);
    expect(watches[0].close).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    await delay(100);
    expect(onSettle).not.toHaveBeenCalled();
    dw.stop();
    expect(watches[0].close).toHaveBeenCalledTimes(1);
  });

  it("an 'error' on the watch is handled, not thrown into the host", () => {
    const root = mkRoot();
    fs.mkdirSync(conduitDir(root));
    const dw = new ConduitDirWatch(20);
    const onGone = vi.fn();
    dw.start(root, () => true, vi.fn(), { onGone });
    expect(() => watches[0].w.emit('error', new Error('EPERM'))).not.toThrow();
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(watches[0].close).toHaveBeenCalledTimes(1);
  });
});

describe('PlanWatcher on a vanished .conduit/plans/', () => {
  it('re-arms the root, so a plan written after the dir is back still arrives', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(conduitDir(root), PLANS_DIR_NAME), { recursive: true });
    const seen: string[] = [];
    const pw = new PlanWatcher((_r, slug) => seen.push(slug), 20);
    try {
      pw.watch(root);
      expect(watches).toHaveLength(1);
      vanish(watches[0]);
      expect(watches[0].close).toHaveBeenCalledTimes(1);
      expect(watches).toHaveLength(2);
      await writePlanFile(root, 'back', '# Back\n');
      await waitFor(() => seen.includes('back'), 3000);
    } finally {
      pw.stop();
    }
  });
});

describe('OpenFileWatcher on a vanished parent dir', () => {
  it('closes that dir watch once and re-arms it on the next setPaths', () => {
    const root = mkRoot();
    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'x');
    const ow = new OpenFileWatcher(vi.fn(), 20);
    try {
      ow.setPaths([file]);
      expect(watches).toHaveLength(1);
      vanish(watches[0]);
      expect(watches[0].close).toHaveBeenCalledTimes(1);
      ow.setPaths([file]);
      expect(watches).toHaveLength(2);
      expect(watches[1].dir).toBe(root);
    } finally {
      ow.stop();
    }
  });
});
