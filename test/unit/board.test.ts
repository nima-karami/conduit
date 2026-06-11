import { describe, expect, it } from 'vitest';
import {
  addCard,
  cardsIn,
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
