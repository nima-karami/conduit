import { describe, expect, it } from 'vitest';
import type { BoardCard, BoardData } from '../../src/board';
import {
  cardSessionPrefill,
  lastLinkedSession,
  linkedRowLabel,
  linkedRowName,
  linkedRowState,
  linkedSessionsForCard,
  proposedAdditionsIn,
  proposedFlags,
} from '../../src/board-linkage';
import { diffBoard } from '../../src/conduit-proposal';
import type { Project, Session } from '../../src/types';

const base = {
  agentId: 'claude',
  home: '/p',
  roots: [],
  createdAt: 100,
  lastActiveAt: 100,
} satisfies Partial<Session>;

const bcard = (
  id: string,
  stage: BoardCard['stage'],
  over: Partial<BoardCard> = {},
): BoardCard => ({
  id,
  title: id.toUpperCase(),
  notes: '',
  stage,
  ...over,
});

describe('board-linkage: proposedFlags', () => {
  it('flags nothing when no proposal is pending', () => {
    expect(proposedFlags(null).size).toBe(0);
  });

  it('flags a card the proposal adds, moves, edits or removes', () => {
    const current: BoardData = {
      version: 1,
      cards: [
        bcard('keep', 'wishlist'),
        bcard('mover', 'planning'),
        bcard('editee', 'building'),
        bcard('goner', 'done'),
      ],
    };
    const proposed: BoardData = {
      version: 1,
      cards: [
        bcard('keep', 'wishlist'),
        bcard('mover', 'building'),
        bcard('editee', 'building', { notes: 'rewritten' }),
        bcard('fresh', 'wishlist'),
      ],
    };
    const flags = proposedFlags(diffBoard(current, proposed));
    expect([...flags.keys()].sort()).toEqual(['editee', 'fresh', 'goner', 'mover']);
    expect(flags.get('keep')).toBeUndefined();
    expect(flags.get('fresh')?.changes).toEqual(['added']);
    expect(flags.get('fresh')?.detail).toBe('new card in Wish list');
    expect(flags.get('mover')?.detail).toBe('move to Building');
    expect(flags.get('editee')?.detail).toBe('edit notes');
    expect(flags.get('goner')?.detail).toBe('remove this card');
  });

  it('merges the facets when one card is both moved and edited', () => {
    const current: BoardData = { version: 1, cards: [bcard('c', 'planning')] };
    const proposed: BoardData = {
      version: 1,
      cards: [bcard('c', 'done', { title: 'Renamed', notes: 'why' })],
    };
    const flag = proposedFlags(diffBoard(current, proposed)).get('c');
    expect(flag?.changes).toEqual(['moved', 'edited']);
    expect(flag?.detail).toBe('move to Done · edit title, notes');
  });

  it('clears itself once the proposal matches the board', () => {
    const board: BoardData = { version: 1, cards: [bcard('c', 'planning')] };
    expect(proposedFlags(diffBoard(board, board)).size).toBe(0);
  });
});

describe('board-linkage: proposedAdditionsIn', () => {
  it('returns only the cards a proposal would add to that stage', () => {
    const current: BoardData = { version: 1, cards: [] };
    const proposed: BoardData = {
      version: 1,
      cards: [bcard('a', 'wishlist'), bcard('b', 'building'), bcard('c', 'wishlist')],
    };
    const diff = diffBoard(current, proposed);
    expect(proposedAdditionsIn(diff, 'wishlist').map((c) => c.id)).toEqual(['a', 'c']);
    expect(proposedAdditionsIn(diff, 'building').map((c) => c.id)).toEqual(['b']);
    expect(proposedAdditionsIn(diff, 'done')).toEqual([]);
  });

  it('is empty with no proposal pending', () => {
    expect(proposedAdditionsIn(null, 'wishlist')).toEqual([]);
  });
});

const linked = (over: Partial<Session> & { id: string }): Session => ({
  ...base,
  name: over.id,
  status: 'running',
  ...over,
});

describe('board-linkage: linkedSessionsForCard (AC1)', () => {
  it('matches cardId with home = boardHome', () => {
    const s = linked({ id: 'a', home: 'C:/src/a', cardId: 'c1' });
    expect(linkedSessionsForCard([s], 'c1', 'C:/src/a')).toEqual([s]);
  });

  it('matches with boardHome an attached root', () => {
    const s = linked({ id: 'a', home: 'C:/src/other', roots: ['C:/src/a'], cardId: 'c1' });
    expect(linkedSessionsForCard([s], 'c1', 'C:/src/a')).toEqual([s]);
  });

  it('drive paths fold case and slashes', () => {
    const s = linked({ id: 'a', home: 'C:\\Src\\A', cardId: 'c1' });
    expect(linkedSessionsForCard([s], 'c1', 'c:/src/a/')).toEqual([s]);
  });

  it('same cardId, folders exclude boardHome → excluded', () => {
    const s = linked({ id: 'a', home: 'C:/src/b', roots: ['C:/src/c'], cardId: 'c1' });
    expect(linkedSessionsForCard([s], 'c1', 'C:/src/a')).toEqual([]);
  });

  it('no cardId never matches', () => {
    expect(
      linkedSessionsForCard([linked({ id: 'a', home: 'C:/src/a' })], 'c1', 'C:/src/a'),
    ).toEqual([]);
  });

  it('boardHome undefined → []', () => {
    const s = linked({ id: 'a', home: 'C:/src/a', cardId: 'c1' });
    expect(linkedSessionsForCard([s], 'c1', undefined)).toEqual([]);
    expect(linkedSessionsForCard([s], 'c1', '')).toEqual([]);
  });
});

describe('board-linkage: rows (AC2)', () => {
  it('input order kept', () => {
    const a = linked({ id: 'a', home: 'C:/h', cardId: 'c1', lastActiveAt: 1 });
    const b = linked({ id: 'b', home: 'C:/h', cardId: 'c1', lastActiveAt: 9 });
    expect(linkedSessionsForCard([b, a], 'c1', 'C:/h').map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('lastLinkedSession: greatest lastActiveAt; tie → first; [] → undefined', () => {
    const a = linked({ id: 'a', lastActiveAt: 5 });
    const b = linked({ id: 'b', lastActiveAt: 9 });
    const c = linked({ id: 'c', lastActiveAt: 9 });
    expect(lastLinkedSession([a, b])?.id).toBe('b');
    expect(lastLinkedSession([b, c])?.id).toBe('b');
    expect(lastLinkedSession([c, b])?.id).toBe('c');
    expect(lastLinkedSession([])).toBeUndefined();
  });

  it('linkedRowState: running→running, exited→stopped, stale→stopped', () => {
    expect(linkedRowState({ status: 'running' })).toBe('running');
    expect(linkedRowState({ status: 'exited' })).toBe('stopped');
    expect(linkedRowState({ status: 'stale' })).toBe('stopped');
  });

  it('linkedRowLabel: "S1, Command Prompt, running" / "…, not running"', () => {
    expect(linkedRowLabel({ name: 'S1', status: 'running' }, 'Command Prompt')).toBe(
      'S1, Command Prompt, running',
    );
    expect(linkedRowLabel({ name: 'S1', status: 'exited' }, 'Command Prompt')).toBe(
      'S1, Command Prompt, not running',
    );
  });

  it('blank name → Untitled session', () => {
    expect(linkedRowName({ name: '  ' })).toBe('Untitled session');
    expect(linkedRowName({ name: ' S1 ' })).toBe('S1');
    expect(linkedRowLabel({ name: '', status: 'stale' }, 'shell')).toBe(
      'Untitled session, shell, not running',
    );
  });
});

describe('board-linkage: cardSessionPrefill (AC5)', () => {
  const projects: Project[] = [{ id: 'p1', name: 'RMB', order: 0 }];
  const agents = [{ id: 'claude' }, { id: 'shell:cmd' }];
  const card = { id: 'c1', title: 'Move RMB to CI' };
  const active = linked({
    id: 'act',
    home: 'C:/h',
    roots: ['C:/r0'],
    projectId: 'p1',
    agentId: 'shell:cmd',
  });

  it('prefill from the last linked session', () => {
    const old = linked({ id: 'o', home: 'C:/h', roots: ['C:/x'], cardId: 'c1', lastActiveAt: 1 });
    const last = linked({
      id: 'l',
      home: 'C:/h',
      roots: ['C:/r1', 'C:/gone'],
      projectId: 'p1',
      agentId: 'claude',
      cardId: 'c1',
      status: 'exited',
      lastActiveAt: 50,
    });
    const p = cardSessionPrefill(card, { sessions: [old, last, active], active, projects, agents });
    expect(p).toEqual({
      home: 'C:/h',
      roots: ['C:/r1', 'C:/gone'],
      projectId: 'p1',
      cardId: 'c1',
      cardTitle: 'Move RMB to CI',
      agentId: 'claude',
    });
  });

  it('no linked session → active home/roots/project, no agentId', () => {
    const p = cardSessionPrefill(card, { sessions: [active], active, projects, agents });
    expect(p).toEqual({
      home: 'C:/h',
      roots: ['C:/r0'],
      projectId: 'p1',
      cardId: 'c1',
      cardTitle: 'Move RMB to CI',
    });
  });

  it('dangling projectId → null', () => {
    const last = linked({ id: 'l', home: 'C:/h', cardId: 'c1', projectId: 'p-gone' });
    const p = cardSessionPrefill(card, { sessions: [last], active, projects, agents });
    expect(p?.projectId).toBeNull();
  });

  it('standalone source → null', () => {
    const last = linked({ id: 'l', home: 'C:/h', cardId: 'c1' });
    const p = cardSessionPrefill(card, { sessions: [last], active, projects, agents });
    expect(p?.projectId).toBeNull();
  });

  it('unregistered last agent → agentId omitted', () => {
    const last = linked({ id: 'l', home: 'C:/h', cardId: 'c1', agentId: 'cli:removed' });
    const p = cardSessionPrefill(card, { sessions: [last], active, projects, agents });
    expect(p).not.toBeNull();
    expect('agentId' in (p ?? {})).toBe(false);
  });

  it('no active → null', () => {
    expect(
      cardSessionPrefill(card, { sessions: [], active: undefined, projects, agents }),
    ).toBeNull();
  });

  it('roots are a copy', () => {
    const last = linked({ id: 'l', home: 'C:/h', roots: ['C:/r1'], cardId: 'c1' });
    const p = cardSessionPrefill(card, { sessions: [last], active, projects, agents });
    expect(p?.roots).toEqual(last.roots);
    expect(p?.roots).not.toBe(last.roots);
  });
});
