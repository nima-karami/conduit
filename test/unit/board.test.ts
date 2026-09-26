import { describe, expect, it } from 'vitest';
import {
  addCard,
  type BoardData,
  cardsIn,
  duplicateCard,
  migrateStage,
  moveCard,
  removeCard,
  restoreBoard,
  seedBoard,
  serializeBoard,
  updateCard,
  wipFor,
} from '../../src/board';

describe('board ops', () => {
  it('adds a card to a stage', () => {
    const b = addCard({ version: 1, cards: [] }, 'wishlist', 'New idea');
    expect(b.cards).toHaveLength(1);
    expect(b.cards[0]).toMatchObject({ title: 'New idea', stage: 'wishlist', notes: '' });
  });

  it('moves a card to another stage', () => {
    let b = addCard({ version: 1, cards: [] }, 'wishlist', 'X');
    const id = b.cards[0].id;
    b = moveCard(b, id, 'building');
    expect(b.cards[0].stage).toBe('building');
    expect(cardsIn(b, 'building').map((c) => c.id)).toEqual([id]);
  });

  it('updates and removes a card', () => {
    let b = addCard({ version: 1, cards: [] }, 'planning', 'X');
    const id = b.cards[0].id;
    b = updateCard(b, id, { notes: 'hello' });
    expect(b.cards[0].notes).toBe('hello');
    b = removeCard(b, id);
    expect(b.cards).toHaveLength(0);
  });

  it('duplicates a card right after the original with a new id and copied fields', () => {
    let b = addCard({ version: 1, cards: [] }, 'planning', 'Design');
    const id = b.cards[0].id;
    b = updateCard(b, id, { notes: 'some notes', links: ['a', 'b'] });
    b = addCard(b, 'planning', 'After'); // a sibling to prove insertion position
    const afterId = b.cards[1].id;

    const out = duplicateCard(b, id);
    expect(out.cards).toHaveLength(3);
    expect(out.cards.map((c) => c.id).indexOf(afterId)).toBe(2);
    const copy = out.cards[1];
    expect(copy.id).not.toBe(id);
    expect(out.cards.map((c) => c.id)).toContain(copy.id);
    expect(new Set(out.cards.map((c) => c.id)).size).toBe(out.cards.length);
    expect(copy.title).toBe('Design (copy)');
    expect(copy.notes).toBe('some notes');
    expect(copy.stage).toBe('planning');
    expect(copy.links).toEqual(['a', 'b']);
  });

  it('duplicateCard is pure and no-ops on an unknown id', () => {
    const src: BoardData = {
      version: 1,
      cards: [{ id: 'x', title: 'T', notes: 'n', stage: 'wishlist', links: ['l'] }],
    };
    const snapshot = JSON.parse(JSON.stringify(src));

    expect(duplicateCard(src, 'nope')).toBe(src); // unchanged reference on miss

    const out = duplicateCard(src, 'x');
    expect(src).toEqual(snapshot);
    expect(out).not.toBe(src);
    expect(out.cards).not.toBe(src.cards);
    // links copied as a fresh array (mutating copy must not affect source)
    out.cards[1].links?.push('mutated');
    expect(src.cards[0].links).toEqual(['l']);
  });

  it('addCard stamps createdAt and updatedAt with the injected now', () => {
    const b = addCard({ version: 1, cards: [] }, 'wishlist', 'Dated', 1000);
    expect(b.cards[0].createdAt).toBe(1000);
    expect(b.cards[0].updatedAt).toBe(1000);
  });

  it('updateCard bumps updatedAt but preserves createdAt', () => {
    let b = addCard({ version: 1, cards: [] }, 'wishlist', 'X', 1000);
    const id = b.cards[0].id;
    b = updateCard(b, id, { notes: 'edited' }, 5000);
    expect(b.cards[0].createdAt).toBe(1000); // preserved
    expect(b.cards[0].updatedAt).toBe(5000); // bumped
    expect(b.cards[0].notes).toBe('edited');
  });

  it('moveCard counts as an update and bumps updatedAt', () => {
    let b = addCard({ version: 1, cards: [] }, 'wishlist', 'X', 1000);
    const id = b.cards[0].id;
    b = moveCard(b, id, 'building', 7000);
    expect(b.cards[0].stage).toBe('building');
    expect(b.cards[0].createdAt).toBe(1000);
    expect(b.cards[0].updatedAt).toBe(7000);
  });

  it('duplicateCard stamps the copy with fresh timestamps and leaves the source alone', () => {
    const b = addCard({ version: 1, cards: [] }, 'planning', 'Design', 1000);
    const id = b.cards[0].id;
    const out = duplicateCard(b, id, 9000);
    const source = out.cards[0];
    const copy = out.cards[1];
    expect(source.createdAt).toBe(1000); // untouched
    expect(source.updatedAt).toBe(1000);
    expect(copy.createdAt).toBe(9000); // fresh, not cloned from source age
    expect(copy.updatedAt).toBe(9000);
  });

  it('tolerates legacy cards with no timestamps and drops non-number ones on restore', () => {
    const blob = JSON.stringify({
      version: 1,
      cards: [
        { id: 'legacy', title: 'no stamps', notes: '', stage: 'done' },
        { id: 'good', title: 'valid', notes: '', stage: 'done', createdAt: 42, updatedAt: 99 },
        {
          id: 'bad',
          title: 'garbage stamps',
          notes: '',
          stage: 'done',
          createdAt: 'nope',
          updatedAt: Number.NaN,
        },
      ],
    });
    const out = restoreBoard(blob);
    const byId = (i: string) => out.cards.find((c) => c.id === i);
    expect(byId('legacy')?.createdAt).toBeUndefined();
    expect(byId('legacy')?.updatedAt).toBeUndefined();
    expect(byId('good')?.createdAt).toBe(42);
    expect(byId('good')?.updatedAt).toBe(99);
    expect(byId('bad')?.createdAt).toBeUndefined();
    expect(byId('bad')?.updatedAt).toBeUndefined();
  });

  it('round-trips through serialize/restore', () => {
    const b = addCard(seedBoard(), 'wishlist', 'Extra');
    const restored = restoreBoard(serializeBoard(b));
    expect(restored.cards.map((c) => c.title)).toEqual(b.cards.map((c) => c.title));
  });

  it('falls back to the seed for missing/invalid blobs', () => {
    expect(restoreBoard(undefined).cards.length).toBeGreaterThan(0);
    expect(restoreBoard('not json').cards.length).toBeGreaterThan(0);
  });

  it('drops cards with invalid stages on restore', () => {
    const blob = JSON.stringify({
      version: 1,
      cards: [
        { id: 'a', title: 'ok', notes: '', stage: 'done' },
        { id: 'b', title: 'bad', stage: 'nope' },
      ],
    });
    const out = restoreBoard(blob);
    expect(out.cards.map((c) => c.id)).toEqual(['a']);
  });
});

describe('migrateStage (phase-pipeline reconciliation)', () => {
  it('maps canonical stages to themselves (idempotent)', () => {
    for (const s of ['wishlist', 'planning', 'building', 'done'] as const) {
      expect(migrateStage(s)).toBe(s);
    }
  });

  it('maps legacy/alias spellings to canonical stages (case-insensitive, trimmed)', () => {
    expect(migrateStage('backlog')).toBe('wishlist');
    expect(migrateStage('Idea')).toBe('wishlist');
    expect(migrateStage('todo')).toBe('planning');
    expect(migrateStage('To-Do')).toBe('planning');
    expect(migrateStage('next')).toBe('planning');
    expect(migrateStage('in-progress')).toBe('building');
    expect(migrateStage('inprogress')).toBe('building');
    expect(migrateStage('WIP')).toBe('building');
    expect(migrateStage('  doing ')).toBe('building');
    expect(migrateStage('complete')).toBe('done');
    expect(migrateStage('Completed')).toBe('done');
    expect(migrateStage('shipped')).toBe('done');
  });

  it('returns null for unrecognized / non-string stages (card gets dropped)', () => {
    expect(migrateStage('nope')).toBeNull();
    expect(migrateStage('')).toBeNull();
    expect(migrateStage(undefined)).toBeNull();
    expect(migrateStage(42)).toBeNull();
  });
});

describe('restoreBoard stage reconciliation', () => {
  it('keeps cards with legacy stage spellings, mapped to canonical stages (none dropped)', () => {
    const blob = JSON.stringify({
      version: 1,
      cards: [
        { id: 'a', title: 'idea', notes: '', stage: 'backlog' },
        { id: 'b', title: 'plan', notes: '', stage: 'todo' },
        { id: 'c', title: 'work', notes: '', stage: 'in-progress' },
        { id: 'd', title: 'shipped', notes: '', stage: 'complete' },
      ],
    });
    const out = restoreBoard(blob);
    expect(out.cards.map((c) => [c.id, c.stage])).toEqual([
      ['a', 'wishlist'],
      ['b', 'planning'],
      ['c', 'building'],
      ['d', 'done'],
    ]);
  });

  it('still drops a card whose stage is unrecognized garbage', () => {
    const blob = JSON.stringify({
      version: 1,
      cards: [
        { id: 'ok', title: 'ok', notes: '', stage: 'done' },
        { id: 'garbage', title: 'g', notes: '', stage: 'frobnicate' },
      ],
    });
    expect(restoreBoard(blob).cards.map((c) => c.id)).toEqual(['ok']);
  });
});

describe('wipFor (column count against its limit)', () => {
  const board: BoardData = {
    version: 1,
    cards: [
      { id: 'a', title: 'A', notes: '', stage: 'planning' },
      { id: 'b', title: 'B', notes: '', stage: 'planning' },
      { id: 'c', title: 'C', notes: '', stage: 'building' },
    ],
  };

  it('reports a plain count with no limit configured', () => {
    expect(wipFor(board, 'planning')).toEqual({ count: 2, state: 'none' });
    expect(wipFor(board, 'planning').limit).toBeUndefined();
  });

  it('counts an empty stage as zero, not as missing', () => {
    expect(wipFor(board, 'done', 3)).toEqual({ count: 0, limit: 3, state: 'under' });
  });

  it('distinguishes under / at / over the limit', () => {
    expect(wipFor(board, 'planning', 3).state).toBe('under');
    expect(wipFor(board, 'planning', 2).state).toBe('at');
    expect(wipFor(board, 'planning', 1).state).toBe('over');
  });

  it('reports the limit back so the readout never has to re-derive it', () => {
    expect(wipFor(board, 'building', 2)).toEqual({ count: 1, limit: 2, state: 'under' });
  });
});

describe('restoreBoard ticket (mf-board §3.5)', () => {
  const blobWith = (ticket: unknown) =>
    JSON.stringify({
      version: 1,
      cards: [{ id: 'c', title: 'C', notes: '', stage: 'building', ticket }],
    });
  const only = (ticket: unknown) => restoreBoard(blobWith(ticket)).cards[0];

  it('restoreBoard keeps a trimmed ticket', () => {
    expect(only({ key: '  RMB-412 ', source: 'Jira', status: 'In progress' }).ticket).toEqual({
      key: 'RMB-412',
      source: 'Jira',
      status: 'In progress',
    });
  });

  it('ticket caps by code point, ending a cut value in an ellipsis', () => {
    const t = only({ key: '😀'.repeat(41), source: 's'.repeat(25), status: 'x'.repeat(33) }).ticket;
    expect(Array.from(t?.key ?? '').length).toBe(40);
    expect(t?.key).toBe(`${'😀'.repeat(39)}…`);
    expect(t?.source).toBe(`${'s'.repeat(23)}…`);
    expect(t?.status).toBe(`${'x'.repeat(31)}…`);
  });

  it('a value exactly at its cap is not marked as cut', () => {
    const t = only({ key: '😀'.repeat(40), source: 's'.repeat(24), status: 'x'.repeat(32) }).ticket;
    expect(t).toEqual({ key: '😀'.repeat(40), source: 's'.repeat(24), status: 'x'.repeat(32) });
  });

  it('a cap that lands on a space leaves no trailing whitespace', () => {
    const t = only({ key: `${'k'.repeat(38)} bb`, status: `${'s'.repeat(30)}  tail` }).ticket;
    expect(t?.key).toBe(`${'k'.repeat(38)}…`);
    expect(t?.status).toBe(`${'s'.repeat(30)}…`);
  });

  it('a cut ticket survives write-back and reload unchanged', () => {
    const first = restoreBoard(
      blobWith({
        key: `${'k'.repeat(38)} bb`,
        source: '😀'.repeat(30),
        status: 'Needs review from the platform team before merge',
      }),
    );
    expect(first.cards[0].ticket?.status).toBe('Needs review from the platform…');
    expect(restoreBoard(serializeBoard(first))).toEqual(first);
  });

  it('non-string and blank sub-fields dropped', () => {
    expect(only({ key: 7, source: '  ', status: 'x' }).ticket).toEqual({ status: 'x' });
  });

  it('empty ticket omitted', () => {
    for (const t of [{ key: '' }, 'str', [], null]) {
      expect('ticket' in only(t)).toBe(false);
    }
  });

  it('malformed ticket never drops the card', () => {
    const board = restoreBoard(blobWith({ key: ['x'] }));
    expect(board.cards.map((c) => c.id)).toEqual(['c']);
  });

  it('duplicateCard does not copy ticket', () => {
    const board = restoreBoard(blobWith({ key: 'RMB-412' }));
    const next = duplicateCard(board, 'c', 5);
    const copy = next.cards[1];
    expect(next.cards[0].ticket).toEqual({ key: 'RMB-412' });
    expect('ticket' in copy).toBe(false);
  });
});
