import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PLAN_BYTES,
  PLANS_DIR_NAME,
  planCommentsPath,
  planPath,
  planWriteRefusal,
  readPlan,
  readPlanComments,
  writePlanCommentsFile,
  writePlanFile,
} from '../../electron/conduit-fs';
import type { PlanComment, PlanCommentsData } from '../../src/plan-comments';

let root: string;

const plansDir = (): string => path.join(root, '.conduit', PLANS_DIR_NAME);

const comment = (id: string): PlanComment => ({
  id,
  author: 'human',
  text: 'Why this shape?',
  anchor: { index: 2, hash: 'h2', snippet: 'The second block' },
  status: 'open',
  createdAt: '2026-09-19T12:00:00.000Z',
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-fs-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('plan paths', () => {
  it('planPath rejects a slug with a slash', () => {
    expect(planPath(root, 'my-plan')).toBe(path.join(plansDir(), 'my-plan.md'));
    expect(planCommentsPath(root, 'my-plan')).toBe(path.join(plansDir(), 'my-plan.comments.json'));

    expect(() => planPath(root, 'a/b')).toThrow('invalid plan slug');
    expect(() => planPath(root, '../escape')).toThrow('invalid plan slug');
    expect(() => planPath(root, 'a\\b')).toThrow('invalid plan slug');
    expect(() => planPath(root, '')).toThrow('invalid plan slug');
    expect(() => planCommentsPath(root, 'a/b')).toThrow('invalid plan slug');
  });
});

describe('readPlan / writePlanFile', () => {
  it('readPlan of a missing plan returns undefined markdown and empty comments', async () => {
    const { markdown, comments } = await readPlan(root, 'nope');
    expect(markdown).toBeUndefined();
    expect(comments).toEqual({ version: 1, comments: [] });
  });

  it('writePlanFile creates .conduit/plans and writes atomically (no .tmp left)', async () => {
    expect(fs.existsSync(plansDir())).toBe(false);

    await writePlanFile(root, 'my-plan', '# Plan\n\nA body.\n');

    expect(fs.readdirSync(plansDir())).toEqual(['my-plan.md']);
    expect(fs.readFileSync(planPath(root, 'my-plan'), 'utf8')).toBe('# Plan\n\nA body.\n');
    const { markdown } = await readPlan(root, 'my-plan');
    expect(markdown).toBe('# Plan\n\nA body.\n');
  });

  it('comments round-trip through the envelope', async () => {
    const data: PlanCommentsData = {
      version: 1,
      baseline: { at: '2026-09-19T12:00:00.000Z', blockHashes: ['h1', 'h2'] },
      comments: [comment('c1')],
    };

    await writePlanCommentsFile(root, 'my-plan', data);

    const onDisk = JSON.parse(fs.readFileSync(planCommentsPath(root, 'my-plan'), 'utf8'));
    expect(onDisk.conduit).toBe(1);
    expect(onDisk.kind).toBe('plan-comments');
    expect(fs.readdirSync(plansDir())).toEqual(['my-plan.comments.json']);

    const { markdown, comments } = await readPlan(root, 'my-plan');
    expect(markdown).toBeUndefined();
    expect(comments).toEqual(data);
  });

  it('readPlan rejects a file over MAX_PLAN_BYTES and one with invalid UTF-8', async () => {
    fs.mkdirSync(plansDir(), { recursive: true });

    fs.writeFileSync(path.join(plansDir(), 'big.md'), Buffer.alloc(MAX_PLAN_BYTES + 1, 0x61));
    await expect(readPlan(root, 'big')).rejects.toThrow(/^plan unreadable: /);

    // A lone 0xff can never appear in valid UTF-8.
    fs.writeFileSync(path.join(plansDir(), 'bad.md'), Buffer.from([0x23, 0x20, 0xff, 0x0a]));
    await expect(readPlan(root, 'bad')).rejects.toThrow(/^plan unreadable: /);

    // The size gate is a ceiling, not a rounding: MAX_PLAN_BYTES exactly still loads.
    fs.writeFileSync(path.join(plansDir(), 'edge.md'), Buffer.alloc(MAX_PLAN_BYTES, 0x61));
    const { markdown } = await readPlan(root, 'edge');
    expect(markdown?.length).toBe(MAX_PLAN_BYTES);
  });
});

describe('readPlanComments', () => {
  it('returns the sidecar of a plan whose .md is unreadable', async () => {
    const data: PlanCommentsData = { version: 1, comments: [comment('c1')] };
    fs.mkdirSync(plansDir(), { recursive: true });
    await writePlanCommentsFile(root, 'big', data);
    await writePlanCommentsFile(root, 'bad', data);

    fs.writeFileSync(path.join(plansDir(), 'big.md'), Buffer.alloc(MAX_PLAN_BYTES + 1, 0x61));
    fs.writeFileSync(path.join(plansDir(), 'bad.md'), Buffer.from([0x23, 0x20, 0xff, 0x0a]));

    // The comments do not depend on the markdown, so an unreadable `.md` must not take them
    // down with it — that is what used to swallow a sidecar event in the watcher.
    await expect(readPlan(root, 'big')).rejects.toThrow(/^plan unreadable: /);
    await expect(readPlan(root, 'bad')).rejects.toThrow(/^plan unreadable: /);
    expect(await readPlanComments(root, 'big')).toEqual(data);
    expect(await readPlanComments(root, 'bad')).toEqual(data);
  });

  it('is an empty set for a missing sidecar and rejects an invalid slug', async () => {
    expect(await readPlanComments(root, 'nope')).toEqual({ version: 1, comments: [] });
    await expect(readPlanComments(root, 'a/b')).rejects.toThrow('invalid plan slug');
  });
});

describe('planWriteRefusal', () => {
  it('refuses an invalid slug before anything is recorded or written', () => {
    expect(planWriteRefusal('my-plan', '# Plan\n')).toBeNull();
    expect(planWriteRefusal('a/b', '# Plan\n')).toBe('invalid plan slug');
    expect(planWriteRefusal('../escape', '# Plan\n')).toBe('invalid plan slug');
    expect(planWriteRefusal('', '# Plan\n')).toBe('invalid plan slug');
  });

  it('refuses markdown over MAX_PLAN_BYTES, counting bytes and not characters', () => {
    expect(planWriteRefusal('my-plan', 'a'.repeat(MAX_PLAN_BYTES))).toBeNull();
    expect(planWriteRefusal('my-plan', 'a'.repeat(MAX_PLAN_BYTES + 1))).toMatch(
      /^plan too large: /,
    );
    // Half as many characters, the same number of bytes: a write readPlan would then refuse.
    expect(planWriteRefusal('my-plan', 'é'.repeat(MAX_PLAN_BYTES / 2 + 1))).toMatch(
      /^plan too large: /,
    );
  });
});
