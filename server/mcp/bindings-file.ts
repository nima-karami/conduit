import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../../src/atomic-write';
import { AGENT_CLIS, type AgentCli } from '../../src/conduit-mcp/install-types';
import {
  type CliBindingRecord,
  judgePersistedVersion,
  SERVER_FILE_VERSION,
} from '../../src/contracts/session-identity';

const FILE = 'conduit-mcp/bindings.json' as const;
const CLIS: ReadonlySet<unknown> = new Set<AgentCli>(AGENT_CLIS);
const isCli = (v: unknown): v is AgentCli => CLIS.has(v);

function toRecord(v: unknown): CliBindingRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const { sessionId, generation, cli, clientInfoName } = v as Record<string, unknown>;
  if (
    typeof sessionId !== 'string' ||
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    !isCli(cli) ||
    typeof clientInfoName !== 'string'
  )
    return null;
  return { sessionId, generation, cli, clientInfoName };
}

/**
 * userData/conduit-mcp/bindings.json (D28): the shell-CLI bindings the host admitted, one per
 * session, so a typed CLI keeps its notices across a server restart. A newer or corrupt file is not
 * read and never overwritten: the bindings it holds are lost for the run, nothing else is.
 */
export function createBindingStore(opts: {
  file: string;
  warn?: (message: string, data?: Record<string, unknown>) => void;
}) {
  const bindings = new Map<string, CliBindingRecord>();
  let writable = true;
  try {
    const v: unknown = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
    if (judgePersistedVersion(FILE, o.version) !== 'read' || !Array.isArray(o.bindings)) {
      writable = false;
      opts.warn?.('bindings.json not readable by this version');
    } else
      for (const raw of o.bindings) {
        const r = toRecord(raw);
        if (r) bindings.set(r.sessionId, r);
      }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      writable = false;
      opts.warn?.('bindings.json unreadable', { err: String(err) });
    }
  }

  const persist = () => {
    if (!writable) return;
    try {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true });
      const data = { version: SERVER_FILE_VERSION[FILE], bindings: [...bindings.values()] };
      atomicWriteFileSync(opts.file, `${JSON.stringify(data)}\n`);
    } catch (err) {
      // A lost binding only costs a typed CLI its notices after a restart.
      opts.warn?.('bindings.json write failed', { err: String(err) });
    }
  };

  return {
    get: (sessionId: string): CliBindingRecord | undefined => bindings.get(sessionId),
    set(record: CliBindingRecord) {
      bindings.set(record.sessionId, record);
      persist();
    },
    delete(sessionId: string) {
      if (bindings.delete(sessionId)) persist();
    },
  };
}
