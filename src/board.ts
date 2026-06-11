// Feature Kanban board model. Pure + unit-tested; persisted to board.json in the
// repo root so both the app and the overnight agent read/write the same file.

export type Stage = 'wishlist' | 'planning' | 'building' | 'done';

export const STAGES: { id: Stage; label: string }[] = [
  { id: 'wishlist', label: 'Wish list' },
  { id: 'planning', label: 'Planning' },
  { id: 'building', label: 'Building' },
  { id: 'done', label: 'Done' },
];

export interface BoardCard {
  id: string;
  title: string;
  notes: string;
  stage: Stage;
  links?: string[];
}

export interface BoardData {
  version: number;
  cards: BoardCard[];
}

const VERSION = 1;
const STAGE_IDS = STAGES.map((s) => s.id);
const isStage = (s: unknown): s is Stage =>
  typeof s === 'string' && (STAGE_IDS as string[]).includes(s);

let idCounter = 0;
const newId = (): string => `card-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function cardsIn(board: BoardData, stage: Stage): BoardCard[] {
  return board.cards.filter((c) => c.stage === stage);
}

export function addCard(board: BoardData, stage: Stage, title: string): BoardData {
  const card: BoardCard = { id: newId(), title: title.trim() || 'Untitled', notes: '', stage };
  return { ...board, cards: [...board.cards, card] };
}

export function updateCard(
  board: BoardData,
  id: string,
  patch: Partial<Omit<BoardCard, 'id'>>,
): BoardData {
  return { ...board, cards: board.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function moveCard(board: BoardData, id: string, stage: Stage): BoardData {
  return updateCard(board, id, { stage });
}

export function removeCard(board: BoardData, id: string): BoardData {
  return { ...board, cards: board.cards.filter((c) => c.id !== id) };
}

export function serializeBoard(board: BoardData): string {
  return JSON.stringify({ version: VERSION, cards: board.cards }, null, 2);
}

/** Restore from a blob; falls back to the seed board when missing/invalid. */
export function restoreBoard(blob: string | undefined): BoardData {
  if (blob) {
    try {
      const parsed = JSON.parse(blob);
      if (parsed && Array.isArray(parsed.cards)) {
        const cards = parsed.cards
          .filter(
            (c: unknown): c is BoardCard =>
              !!c &&
              typeof (c as BoardCard).id === 'string' &&
              typeof (c as BoardCard).title === 'string' &&
              isStage((c as BoardCard).stage),
          )
          .map((c: BoardCard) => ({
            id: c.id,
            title: c.title,
            notes: typeof c.notes === 'string' ? c.notes : '',
            stage: c.stage,
            links: Array.isArray(c.links) ? c.links : undefined,
          }));
        return { version: VERSION, cards };
      }
    } catch {
      /* fall through to seed */
    }
  }
  return seedBoard();
}

/** Initial board seeded from the deep-build backlog so it's useful immediately. */
export function seedBoard(): BoardData {
  const done = (n: string, title: string): BoardCard => ({
    id: `seed-${n}`,
    title,
    notes: '',
    stage: 'done',
  });
  return {
    version: VERSION,
    cards: [
      done('f1', 'Settings depth + remove customization buttons'),
      done('f2', 'Sidebar collapse + back/forward navigation'),
      done('f3', 'Configurable session cards'),
      done('f4', 'Unified command palette (recents + prefixes)'),
      done('f5', 'Context menus on files & changes'),
      done('f6', 'Drag-and-drop reorder tabs & sessions'),
      done('f7', 'Configurable dockable layout'),
      done('f8', 'Animated background depth (Flow + intensity)'),
      {
        id: 'seed-f9',
        title: 'Feature Kanban board',
        notes: 'This board. Shared between the user and the overnight agent.',
        stage: 'building',
      },
      {
        id: 'seed-idea1',
        title: 'Project-wide go-to-definition',
        notes: 'Needs the Monaco TS language worker.',
        stage: 'wishlist',
      },
      {
        id: 'seed-idea2',
        title: 'Editable files + save',
        notes: 'Monaco is read-only today.',
        stage: 'wishlist',
      },
      {
        id: 'seed-idea3',
        title: 'Packaged installer',
        notes: 'electron-builder for a distributable.',
        stage: 'wishlist',
      },
    ],
  };
}
