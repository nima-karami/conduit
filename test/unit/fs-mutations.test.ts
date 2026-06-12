import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDir,
  createFile,
  type FsMutationRequest,
  planMutation,
  remove,
  removePermanent,
  rename,
} from '../../src/fs-mutations';
import { tempRoots } from '../helpers/temp-roots';

const { root, cleanup } = tempRoots('fsmut-');
afterEach(cleanup);

const J = (...p: string[]) => path.join(...p);

describe('planMutation — pure containment + rules', () => {
  it('rejects when there are no workspace roots', () => {
    const plan = planMutation({ op: 'createFile', path: '/anywhere/x.ts' }, []);
    expect(plan.kind).toBe('reject');
  });

  it('accepts a createFile inside a root', () => {
    const r = root();
    const plan = planMutation({ op: 'createFile', path: J(r, 'a.ts') }, [r]);
    expect(plan.kind).toBe('createFile');
  });

  it('rejects a createFile that escapes via ..', () => {
    const r = root();
    const plan = planMutation({ op: 'createFile', path: J(r, '..', 'evil.ts') }, [r]);
    expect(plan.kind).toBe('reject');
  });

  it('rejects a createFile outside every root (absolute)', () => {
    const r = root();
    const other = root();
    const plan = planMutation({ op: 'createFile', path: J(other, 'x.ts') }, [r]);
    expect(plan.kind).toBe('reject');
  });

  it('rejects createFile onto an existing path (no clobber)', () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    const plan = planMutation({ op: 'createFile', path: J(r, 'a.ts') }, [r]);
    expect(plan).toMatchObject({ kind: 'reject' });
  });

  it('createDir is allowed even if it already exists (recursive-ok)', () => {
    const r = root();
    fs.mkdirSync(J(r, 'sub'));
    const plan = planMutation({ op: 'createDir', path: J(r, 'sub') }, [r]);
    expect(plan.kind).toBe('createDir');
  });

  describe('rename — both ends validated', () => {
    it('accepts a rename inside the root', () => {
      const r = root();
      fs.writeFileSync(J(r, 'a.ts'), 'x');
      const plan = planMutation({ op: 'rename', from: J(r, 'a.ts'), to: J(r, 'b.ts') }, [r]);
      expect(plan.kind).toBe('rename');
    });

    it('rejects when the SOURCE escapes the root', () => {
      const r = root();
      const plan = planMutation({ op: 'rename', from: J(r, '..', 'a.ts'), to: J(r, 'b.ts') }, [r]);
      expect(plan.kind).toBe('reject');
    });

    it('rejects when the TARGET escapes the root', () => {
      const r = root();
      fs.writeFileSync(J(r, 'a.ts'), 'x');
      const plan = planMutation({ op: 'rename', from: J(r, 'a.ts'), to: J(r, '..', 'b.ts') }, [r]);
      expect(plan.kind).toBe('reject');
    });

    it('rejects a rename onto an existing target (collision)', () => {
      const r = root();
      fs.writeFileSync(J(r, 'a.ts'), 'x');
      fs.writeFileSync(J(r, 'b.ts'), 'y');
      const plan = planMutation({ op: 'rename', from: J(r, 'a.ts'), to: J(r, 'b.ts') }, [r]);
      expect(plan).toMatchObject({ kind: 'reject' });
    });

    it('rejects renaming a missing source', () => {
      const r = root();
      const plan = planMutation({ op: 'rename', from: J(r, 'nope.ts'), to: J(r, 'b.ts') }, [r]);
      expect(plan).toMatchObject({ kind: 'reject' });
    });

    it('rejects renaming a workspace root itself', () => {
      const r = root();
      const plan = planMutation({ op: 'rename', from: r, to: J(r, '..', 'renamed') }, [r]);
      expect(plan.kind).toBe('reject');
    });
  });

  describe('root-protection on delete', () => {
    it('rejects remove of a workspace root', () => {
      const r = root();
      expect(planMutation({ op: 'remove', path: r }, [r]).kind).toBe('reject');
    });
    it('rejects removePermanent of a workspace root', () => {
      const r = root();
      expect(planMutation({ op: 'removePermanent', path: r }, [r]).kind).toBe('reject');
    });
    it('accepts remove of a file inside the root', () => {
      const r = root();
      fs.writeFileSync(J(r, 'a.ts'), 'x');
      expect(planMutation({ op: 'remove', path: J(r, 'a.ts') }, [r]).kind).toBe('remove');
    });
  });
});

describe('execution against a temp dir', () => {
  it('createFile creates an empty file', async () => {
    const r = root();
    const res = await createFile(J(r, 'new.ts'), [r]);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(J(r, 'new.ts'), 'utf8')).toBe('');
  });

  it('createFile mkdir -p the parent', async () => {
    const r = root();
    const res = await createFile(J(r, 'a', 'b', 'c.ts'), [r]);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(J(r, 'a', 'b', 'c.ts'))).toBe(true);
  });

  it('createFile fails on an existing file (no clobber)', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'keep');
    const res = await createFile(J(r, 'a.ts'), [r]);
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(J(r, 'a.ts'), 'utf8')).toBe('keep');
  });

  it('createDir creates a folder', async () => {
    const r = root();
    const res = await createDir(J(r, 'sub', 'deep'), [r]);
    expect(res.ok).toBe(true);
    expect(fs.statSync(J(r, 'sub', 'deep')).isDirectory()).toBe(true);
  });

  it('rename moves a file', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    const res = await rename(J(r, 'a.ts'), J(r, 'b.ts'), [r]);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(J(r, 'a.ts'))).toBe(false);
    expect(fs.existsSync(J(r, 'b.ts'))).toBe(true);
  });

  it('remove calls the injected trash and reports success', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    const trash = vi.fn(async (p: string) => {
      fs.rmSync(p); // simulate the OS moving it to the recycle bin
    });
    const res = await remove(J(r, 'a.ts'), [r], trash);
    expect(res.ok).toBe(true);
    expect(trash).toHaveBeenCalledWith(J(r, 'a.ts'));
    expect(fs.existsSync(J(r, 'a.ts'))).toBe(false);
  });

  it('remove surfaces a trash failure WITHOUT permanently deleting', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    const trash = vi.fn(async () => {
      throw new Error('no recycle bin');
    });
    const res = await remove(J(r, 'a.ts'), [r], trash);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('no recycle bin');
    // The file must still be on disk — no silent permanent delete.
    expect(fs.existsSync(J(r, 'a.ts'))).toBe(true);
  });

  it('removePermanent deletes a folder recursively', async () => {
    const r = root();
    fs.mkdirSync(J(r, 'sub'));
    fs.writeFileSync(J(r, 'sub', 'a.ts'), 'x');
    const res = await removePermanent(J(r, 'sub'), [r]);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(J(r, 'sub'))).toBe(false);
  });

  it('remove refuses a workspace root even with a trash fn', async () => {
    const r = root();
    const trash = vi.fn(async () => {});
    const res = await remove(r, [r], trash);
    expect(res.ok).toBe(false);
    expect(trash).not.toHaveBeenCalled();
  });

  it('an out-of-workspace request never touches disk', async () => {
    const r = root();
    const outside = root();
    const req: FsMutationRequest = { op: 'createFile', path: J(outside, 'evil.ts') };
    const res = await createFile(req.op === 'createFile' ? req.path : '', [r]);
    expect(res.ok).toBe(false);
    expect(fs.existsSync(J(outside, 'evil.ts'))).toBe(false);
  });
});
