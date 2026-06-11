import { describe, expect, it } from 'vitest';
import {
  addCard,
  type BoardData,
  cardsIn,
  duplicateCard,
  moveCard,
  removeCard,
  restoreBoard,
  seedBoard,
  serializeBoard,
  updateCard,
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
    // copy sits immediately after the original, before the sibling
    expect(out.cards.map((c) => c.id).indexOf(afterId)).toBe(2);
    const copy = out.cards[1];
    expect(copy.id).not.toBe(id);
    expect(out.cards.map((c) => c.id)).toContain(copy.id);
    // unique among all cards
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
    // input untouched
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
