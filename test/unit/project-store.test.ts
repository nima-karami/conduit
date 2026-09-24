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
