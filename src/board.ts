// Feature Kanban board model. Pure + unit-tested; persisted per opened project to
// `<projectRoot>/.conduit/board.json` (see electron/conduit-fs.ts, ADR 0002).

export type Stage = 'wishlist' | 'planning' | 'building' | 'done';

export const STAGES: { id: Stage; label: string }[] = [
  { id: 'wishlist', label: 'Wish list' },
  { id: 'planning', label: 'Planning' },
  { id: 'building', label: 'Building' },
  { id: 'done', label: 'Done' },
];

/** Read-only tracker reference written by an external tool. Conduit never writes it
 *  (spec 2026-09-23-mf-board §3.5). */
export interface BoardTicket {
  key?: string;
  source?: string;
  status?: string;
}

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
  ticket?: BoardTicket;
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

const TICKET_CAPS = { key: 40, source: 24, status: 32 } as const;

/** Capped by code point so an astral character is never split (spec 2026-09-23-mf-board §3.5).
 *  A cut value is kept at exactly its cap, never trimmed shorter: that length is how
 *  `ticketDisplay` knows it was cut, and it survives the board being written back. */
function restoreTicket(raw: unknown): BoardTicket | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const ticket: BoardTicket = {};
  for (const field of ['key', 'source', 'status'] as const) {
    const v = (raw as Record<string, unknown>)[field];
    if (typeof v !== 'string' || !v.trim()) continue;
    ticket[field] = Array.from(v.trim()).slice(0, TICKET_CAPS[field]).join('');
  }
  return Object.keys(ticket).length > 0 ? ticket : undefined;
}

/** A ticket part as shown: a value at its cap was (almost always) cut on load, so it ends in "…"
 *  rather than reading as complete. Display only — the stored value is untouched. */
export function ticketDisplay(field: keyof BoardTicket, value: string): string {
  return Array.from(value).length >= TICKET_CAPS[field] ? `${value.trimEnd()}…` : value;
}

let idCounter = 0;
const newId = (): string => `card-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function cardsIn(board: BoardData, stage: Stage): BoardCard[] {
  return board.cards.filter((c) => c.stage === stage);
}

/** How a column's card count sits against its configured WIP limit. `none` = no limit
 *  configured, which is the default and must read as a plain count, never `2/undefined`. */
export type WipState = 'none' | 'under' | 'at' | 'over';

export interface Wip {
  count: number;
  /** Absent unless `.conduit/pipeline.json` configures one for this stage. */
  limit?: number;
  state: WipState;
}

/**
 * Count a stage against its WIP limit. The limit is passed in rather than read here so
 * this stays free of the pipeline config (which imports this module). `over` is reachable
 * because nothing blocks a move — the count reports accumulation, it doesn't police it.
 */
export function wipFor(board: BoardData, stage: Stage, limit?: number): Wip {
  const count = cardsIn(board, stage).length;
  if (limit === undefined) return { count, state: 'none' };
  return { count, limit, state: count > limit ? 'over' : count === limit ? 'at' : 'under' };
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
            const ticket = restoreTicket(card.ticket);
            return {
              id: card.id,
              title: card.title,
              notes: typeof card.notes === 'string' ? card.notes : '',
              stage,
              links: Array.isArray(card.links) ? card.links : undefined,
              createdAt: finiteOrUndef(card.createdAt),
              updatedAt: finiteOrUndef(card.updatedAt),
              ...(ticket ? { ticket } : {}),
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
