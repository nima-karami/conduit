import { describe, expect, it } from 'vitest';
import { ProjectStore, parseProjects, serializeProjects } from '../../src/project-store';

const text = (v: unknown) => ({ kind: 'text' as const, text: JSON.stringify(v) });

describe('parseProjects', () => {
  it('absent → absent', () => {
    expect(parseProjects({ kind: 'absent' })).toEqual({ kind: 'absent' });
  });

  it('unreadable passes through', () => {
    expect(parseProjects({ kind: 'unreadable', code: 'EBUSY' })).toEqual({
      kind: 'unreadable',
      code: 'EBUSY',
    });
  });

  it('not JSON / wrong shape → corrupt', () => {
    expect(parseProjects({ kind: 'text', text: '{nope' })).toEqual({ kind: 'corrupt' });
    expect(parseProjects(text(null))).toEqual({ kind: 'corrupt' });
    expect(parseProjects(text([]))).toEqual({ kind: 'corrupt' });
    expect(parseProjects(text({ version: 1, projects: {} }))).toEqual({ kind: 'corrupt' });
    expect(parseProjects(text({ version: '1', projects: [] }))).toEqual({ kind: 'corrupt' });
    expect(parseProjects(text({ projects: [] }))).toEqual({ kind: 'corrupt' });
  });

  it('version 2 → future 2', () => {
    expect(parseProjects(text({ version: 2, projects: [] }))).toEqual({
      kind: 'future',
      version: 2,
    });
  });

  it('duplicate ids keep the first', () => {
    const r = parseProjects(
      text({
        version: 1,
        projects: [
          { id: 'a', name: 'First', order: 0 },
          { id: 'b', name: 'B', order: 1 },
          { id: 'a', name: 'Second', order: 2 },
          { id: '', name: 'no id', order: 3 },
          'junk',
        ],
      }),
    );
    expect(r).toEqual({
      kind: 'ok',
      projects: [
        { id: 'a', name: 'First', order: 0 },
        { id: 'b', name: 'B', order: 1 },
      ],
    });
  });

  it('empty or non-string name → Untitled project', () => {
    const r = parseProjects(
      text({
        version: 1,
        projects: [
          { id: 'a', name: '   ', order: 0 },
          { id: 'b', name: 7, order: 1 },
          { id: 'c', name: '  Kept  ', order: 2 },
        ],
      }),
    );
    expect(r).toEqual({
      kind: 'ok',
      projects: [
        { id: 'a', name: 'Untitled project', order: 0 },
        { id: 'b', name: 'Untitled project', order: 1 },
        { id: 'c', name: 'Kept', order: 2 },
      ],
    });
  });

  it('non-finite order sorts last, renumbered 0..n-1', () => {
    const r = parseProjects(
      text({
        version: 1,
        projects: [
          { id: 'x', name: 'X', order: 'high' },
          { id: 'b', name: 'B', order: 10 },
          { id: 'y', name: 'Y' },
          { id: 'a', name: 'A', order: -3 },
        ],
      }),
    );
    expect(r).toEqual({
      kind: 'ok',
      projects: [
        { id: 'a', name: 'A', order: 0 },
        { id: 'b', name: 'B', order: 1 },
        { id: 'x', name: 'X', order: 2 },
        { id: 'y', name: 'Y', order: 3 },
      ],
    });
  });

  it('serialize round-trips', () => {
    const projects = [
      { id: 'p-1', name: 'One', order: 0 },
      { id: 'p-2', name: 'Two', order: 1 },
    ];
    const blob = serializeProjects(projects);
    expect(JSON.parse(blob)).toEqual({ version: 1, projects });
    expect(parseProjects({ kind: 'text', text: blob })).toEqual({ kind: 'ok', projects });
  });
});

describe('ProjectStore', () => {
  it('list returns copies sorted by order', () => {
    const initial = [
      { id: 'b', name: 'B', order: 1 },
      { id: 'a', name: 'A', order: 0 },
    ];
    const store = new ProjectStore(initial, () => 'unused');
    const listed = store.list();
    expect(listed.map((p) => p.id)).toEqual(['a', 'b']);
    listed[0].name = 'mutated';
    initial[0].name = 'mutated';
    expect(store.list()).toEqual([
      { id: 'a', name: 'A', order: 0 },
      { id: 'b', name: 'B', order: 1 },
    ]);
  });
});

describe('ProjectStore mutations', () => {
  function store(
    initial = [
      { id: 'a', name: 'A', order: 0 },
      { id: 'b', name: 'B', order: 1 },
      { id: 'c', name: 'C', order: 2 },
    ],
  ) {
    let n = 0;
    const s = new ProjectStore(initial, () => `new${n++}`);
    const h = { s, emits: 0 };
    s.onChange(() => h.emits++);
    return h;
  }

  it('name trimmed, whitespace collapsed, 1..80 else null', () => {
    const h = store([]);
    expect(h.s.create('  Big \t  Project\n x ')?.name).toBe('Big Project x');
    expect(h.s.create('x'.repeat(80))?.name).toBe('x'.repeat(80));
    expect(h.s.create('x'.repeat(81))).toBeNull();
    expect(h.s.create('   ')).toBeNull();
    expect(h.s.create(42)).toBeNull();
    expect(h.s.list()).toHaveLength(2);
  });

  it('create order = max+1, emits', () => {
    const h = store([
      { id: 'a', name: 'A', order: 0 },
      { id: 'b', name: 'B', order: 5 },
    ]);
    const p = h.s.create('New');
    expect(p).toEqual({ id: 'new0', name: 'New', order: 6 });
    expect(h.s.has('new0')).toBe(true);
    expect(h.s.list().map((x) => x.id)).toEqual(['a', 'b', 'new0']);
    expect(h.emits).toBe(1);
    expect(store([]).s.create('First')?.order).toBe(0);
  });

  it('rename invalid → false, no emit', () => {
    const h = store();
    expect(h.s.rename('a', '  ')).toBe(false);
    expect(h.s.rename('zzz', 'Name')).toBe(false);
    expect(h.s.rename(7, 'Name')).toBe(false);
    expect(h.s.rename('a', 'A')).toBe(false);
    expect(h.emits).toBe(0);
    expect(h.s.rename('a', ' Alpha  one ')).toBe(true);
    expect(h.s.list()[0]).toEqual({ id: 'a', name: 'Alpha one', order: 0 });
    expect(h.emits).toBe(1);
  });

  it('reorder: dupes first wins, unknown ignored, missing appended, renumbered', () => {
    const h = store();
    expect(h.s.reorder(['c', 'zzz', 'c', 'a'])).toBe(true);
    expect(h.s.list()).toEqual([
      { id: 'c', name: 'C', order: 0 },
      { id: 'a', name: 'A', order: 1 },
      { id: 'b', name: 'B', order: 2 },
    ]);
    expect(h.emits).toBe(1);
  });

  it('non-array ids → false', () => {
    const h = store();
    expect(h.s.reorder('a,b')).toBe(false);
    expect(h.s.reorder(['a', 3])).toBe(false);
    expect(h.emits).toBe(0);
    expect(h.s.list().map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('delete unknown → false', () => {
    const h = store();
    expect(h.s.delete('zzz')).toBe(false);
    expect(h.s.delete(null)).toBe(false);
    expect(h.emits).toBe(0);
    expect(h.s.delete('b')).toBe(true);
    expect(h.s.has('b')).toBe(false);
    expect(h.s.list()).toEqual([
      { id: 'a', name: 'A', order: 0 },
      { id: 'c', name: 'C', order: 1 },
    ]);
    expect(h.emits).toBe(1);
  });

  it('replaceAll replaces and emits', () => {
    const h = store();
    const next = [{ id: 'z', name: 'Z', order: 0 }];
    h.s.replaceAll(next);
    next[0].name = 'mutated';
    expect(h.s.list()).toEqual([{ id: 'z', name: 'Z', order: 0 }]);
    expect(h.s.has('a')).toBe(false);
    expect(h.emits).toBe(1);
  });

  it('onChange dispose stops notifications', () => {
    const h = store();
    let other = 0;
    const sub = h.s.onChange(() => other++);
    sub.dispose();
    h.s.create('X');
    expect(other).toBe(0);
    expect(h.emits).toBe(1);
  });
});
