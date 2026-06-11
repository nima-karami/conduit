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
  /** Epoch ms when the card was created. Optional for back-compat with older board.json. */
  createdAt?: number;
  /** Epoch ms when the card was last mutated. Optional for back-compat with older board.json. */
  updatedAt?: number;
}

export interface BoardData {
  version: number;
  cards: BoardCard[];
}

const VERSION = 1;

/** Legacy / alias stage spellings → the canonical phase pipeline. The app only ever
 *  *writes* the four canonical ids; this small table rescues the handful of plausible
 *  spellings an external agent or older board might use, so those cards load into
 *  Wishlist → Planning → Building → Done instead of being silently dropped. Kept
 *  deliberately narrow — an unrecognized stage is treated as malformed, not parked. */
const STAGE_ALIASES: Record<string, Stage> = {
  wishlist: 'wishlist',
  backlog: 'wishlist',
  idea: 'wishlist',
  planning: 'planning',
  todo: 'planning',
  'to-do': 'planning',
  next: 'planning',
  building: 'building',
  'in-progress': 'building',
  inprogress: 'building',
  wip: 'building',
  doing: 'building',
  done: 'done',
  complete: 'done',
  completed: 'done',
  shipped: 'done',
};

/**
 * Reconcile any incoming stage string to the canonical phase pipeline. Canonical stages
 * map to themselves (idempotent); known legacy spellings map forward; anything else
 * (unrecognized or non-string) returns `null` so the card is dropped as malformed —
 * we don't resurrect garbage stages into the visible board.
 */
export function migrateStage(raw: unknown): Stage | null {
  if (typeof raw !== 'string') return null;
  return STAGE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** Keep only finite numeric timestamps; drop NaN / non-numbers / garbage to `undefined`. */
const finiteOrUndef = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? n : undefined;

let idCounter = 0;
const newId = (): string => `card-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function cardsIn(board: BoardData, stage: Stage): BoardCard[] {
  return board.cards.filter((c) => c.stage === stage);
}

export function addCard(
  board: BoardData,
  stage: Stage,
  title: string,
  now: number = Date.now(),
): BoardData {
  const card: BoardCard = {
    id: newId(),
    title: title.trim() || 'Untitled',
    notes: '',
    stage,
    createdAt: now,
    updatedAt: now,
  };
  return { ...board, cards: [...board.cards, card] };
}

export function updateCard(
  board: BoardData,
  id: string,
  patch: Partial<Omit<BoardCard, 'id'>>,
  now: number = Date.now(),
): BoardData {
  return {
    ...board,
    cards: board.cards.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: now } : c)),
  };
}

export function moveCard(
  board: BoardData,
  id: string,
  stage: Stage,
  now: number = Date.now(),
): BoardData {
  return updateCard(board, id, { stage }, now);
}

/** Insert a copy of `id` immediately after the original, with a fresh id. No-op if unknown. */
export function duplicateCard(board: BoardData, id: string, now: number = Date.now()): BoardData {
  const index = board.cards.findIndex((c) => c.id === id);
  if (index < 0) return board;
  const source = board.cards[index];
  const copy: BoardCard = {
    id: newId(),
    title: `${source.title} (copy)`,
    notes: source.notes,
    stage: source.stage,
    ...(source.links ? { links: [...source.links] } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const cards = [...board.cards];
  cards.splice(index + 1, 0, copy);
  return { ...board, cards };
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
          .map((c: unknown): BoardCard | null => {
            if (
              !c ||
              typeof (c as BoardCard).id !== 'string' ||
              typeof (c as BoardCard).title !== 'string'
            ) {
              return null;
            }
            // Reconcile legacy/alias stage spellings to the canonical pipeline; an
            // unrecognized stage drops the card (returns null below).
            const stage = migrateStage((c as BoardCard).stage);
            if (!stage) return null;
            const card = c as BoardCard;
            return {
              id: card.id,
              title: card.title,
              notes: typeof card.notes === 'string' ? card.notes : '',
              stage,
              links: Array.isArray(card.links) ? card.links : undefined,
              createdAt: finiteOrUndef(card.createdAt),
              updatedAt: finiteOrUndef(card.updatedAt),
            };
          })
          .filter((c: BoardCard | null): c is BoardCard => c !== null);
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
