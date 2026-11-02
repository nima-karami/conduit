import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../../src/atomic-write';
import type { TokenRows, TokenStorePort } from '../../src/contracts/server-ports';
import {
  judgePersistedVersion,
  SERVER_FILE_VERSION,
  type TokenRecord,
  type TokenState,
} from '../../src/contracts/session-identity';

const FILE = 'conduit-mcp/tokens.json' as const;
const STATES: ReadonlySet<unknown> = new Set<TokenState>([
  'reserved',
  'live',
  'unconfirmed',
  'superseded',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isState = (v: unknown): v is TokenState => STATES.has(v);

function toRow(v: unknown): TokenRecord | null {
  if (!isRecord(v)) return null;
  const { sessionId, sha256, generation, launchId, state, hcAddress, createdAt } = v;
  if (
    typeof sessionId !== 'string' ||
    typeof sha256 !== 'string' ||
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    typeof launchId !== 'string' ||
    !isState(state) ||
    (hcAddress !== null && typeof hcAddress !== 'string') ||
    typeof createdAt !== 'string'
  )
    return null;
  return { sessionId, sha256, generation, launchId, state, hcAddress, createdAt };
}

type Loaded =
  | { state: 'loaded' | 'missing'; rows: TokenRecord[] }
  | { state: 'unreadable'; why: string };

function load(file: string): Loaded {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', rows: [] };
    return { state: 'unreadable', why: String(err) };
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { state: 'unreadable', why: 'not json' };
  }
  if (!isRecord(v)) return { state: 'unreadable', why: 'not an object' };
  const version = judgePersistedVersion(FILE, v.version);
  if (version !== 'read') return { state: 'unreadable', why: `version ${version}` };
  if (!Array.isArray(v.rows)) return { state: 'unreadable', why: 'no rows' };
  const rows: TokenRecord[] = [];
  for (const raw of v.rows) {
    const row = toRow(raw);
    // One bad row may be a live agent's: loading the rest would let reconcile kill it (D21).
    if (!row) return { state: 'unreadable', why: 'bad row' };
    rows.push(row);
  }
  return { state: 'loaded', rows };
}

export interface PersistentTokenStoreOptions {
  /** userData/conduit-mcp/tokens.json. */
  file: string;
  randomToken?: () => string;
  now?: () => number;
  /** Atomic by default; injectable so a failed write is testable. */
  write?: (file: string, data: string) => void;
  warn?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * The sole owner of tokens.json (C7 TokenStorePort, D21). Each change is on disk before its call
 * resolves, so a reservation exists before its run. An unreadable or newer file is left untouched for
 * the run (reconcile adopts and kills nothing, the endpoint welcomes `draining`); a reservation then
 * still mints a token so the launch runs, but it is neither kept nor resolvable until a person acts.
 */
export function createPersistentTokenStore(opts: PersistentTokenStoreOptions): TokenStorePort {
  const randomToken = opts.randomToken ?? (() => randomBytes(32).toString('hex'));
  const now = opts.now ?? Date.now;
  const write =
    opts.write ??
    ((file: string, data: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteFileSync(file, data);
    });
  const initial = load(opts.file);
  if (initial.state === 'unreadable')
    opts.warn?.('tokens.json unreadable; MCP is draining', { why: initial.why });
  const unreadable = initial.state === 'unreadable';
  let persisted = initial.state === 'loaded';
  let rows: TokenRecord[] = initial.state === 'unreadable' ? [] : initial.rows;

  /** The change is written from a copy and becomes current only once the write succeeded. */
  const commit = (change: (draft: TokenRecord[]) => TokenRecord[] | null) => {
    if (unreadable) return;
    const next = change(rows.map((r) => ({ ...r })));
    if (next === null) return;
    write(opts.file, `${JSON.stringify({ version: SERVER_FILE_VERSION[FILE], rows: next })}\n`);
    rows = next;
    persisted = true;
  };
  const update = (launchId: string, apply: (row: TokenRecord) => boolean) =>
    commit((draft) => {
      const row = draft.find((r) => r.launchId === launchId);
      return row && apply(row) ? draft : null;
    });

  return {
    async reserve(sessionId, ids) {
      const token = randomToken();
      commit((draft) => [
        ...draft.flatMap((row): TokenRecord[] => {
          if (row.sessionId !== sessionId || row.state === 'superseded') return [row];
          return row.state === 'unconfirmed' ? [{ ...row, state: 'superseded' }] : [];
        }),
        {
          sessionId,
          ...ids,
          sha256: createHash('sha256').update(token).digest('hex'),
          state: 'reserved',
          hcAddress: null,
          createdAt: new Date(now()).toISOString(),
        },
      ]);
      return { token };
    },
    async resolveAddress(launchId, hcAddress) {
      update(launchId, (row) => {
        row.hcAddress = hcAddress;
        if (row.state !== 'superseded') row.state = 'live';
        return true;
      });
    },
    async markUnconfirmed(launchId) {
      update(launchId, (row) => {
        if (row.state !== 'reserved') return false;
        row.state = 'unconfirmed';
        return true;
      });
    },
    async markSuperseded(launchId) {
      update(launchId, (row) => {
        row.state = 'superseded';
        return true;
      });
    },
    rows(): TokenRows {
      if (unreadable) return { state: 'unreadable' };
      if (!persisted) return { state: 'missing' };
      return { state: 'loaded', rows: rows.map((r) => ({ ...r })) };
    },
    async revoke(key) {
      commit((draft) => {
        const keep = draft.filter((r) =>
          'sessionId' in key ? r.sessionId !== key.sessionId : r.launchId !== key.launchId,
        );
        return keep.length === draft.length ? null : keep;
      });
    },
  };
}
