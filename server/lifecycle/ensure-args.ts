import { isAbsolute } from 'node:path';
import type { StartMethod } from '../../src/network/remote-scripts';
import { argValue } from './cli-args';

// The one StartMethod is defined beside the probe that decides it (remote-scripts.ts).
const START_METHODS: readonly StartMethod[] = ['scope', 'plain', 'windows-task'];
const isStartMethod = (x: string | undefined): x is StartMethod =>
  START_METHODS.some((m) => m === x);

export interface EnsureArgs {
  userData: string;
  method: StartMethod;
  /**
   * The controller's pre-start expectation. Parsed for compatibility and not used: ensure reports the
   * linger it measures after the start (ensure-server.ts), because hc turns linger on at its start.
   */
  survivesLogout: boolean;
  hc?: string;
  /** Forwarded to the server, which runs its MCP shim from here (see server/main.ts). */
  shimDir?: string;
}

const ENSURE_USAGE =
  'usage: main.js --ensure-server --user-data <dir> --start scope|plain|windows-task --survives-logout yes|no [--hc <path>] [--shim-dir <abs path>]';

export type EnsureArgsResult = { ok: true; args: EnsureArgs } | { ok: false; error: string };

/** A missing or unknown value is a usage error: the caller must choose the method, never default it. */
export function parseEnsureArgs(args: readonly string[]): EnsureArgsResult {
  const userData = argValue(args, '--user-data');
  if (!userData) return { ok: false, error: `missing --user-data\n${ENSURE_USAGE}` };
  if (!isAbsolute(userData))
    return { ok: false, error: `--user-data must be an absolute path\n${ENSURE_USAGE}` };
  const start = argValue(args, '--start');
  if (!isStartMethod(start))
    return {
      ok: false,
      error: `--start must be one of ${START_METHODS.join(', ')}\n${ENSURE_USAGE}`,
    };
  const survives = argValue(args, '--survives-logout');
  if (survives !== 'yes' && survives !== 'no')
    return { ok: false, error: `--survives-logout must be yes or no\n${ENSURE_USAGE}` };
  const hc = argValue(args, '--hc');
  // Presence is decided by the token, not by the value: `--shim-dir --hc x` must not read as absent.
  const shimPresent = args.some((a) => a === '--shim-dir' || a.startsWith('--shim-dir='));
  const shimDir = shimPresent ? argValue(args, '--shim-dir') : undefined;
  if (shimPresent && (!shimDir || !isAbsolute(shimDir)))
    return { ok: false, error: `--shim-dir must be an absolute path\n${ENSURE_USAGE}` };
  return {
    ok: true,
    args: {
      userData,
      method: start,
      survivesLogout: survives === 'yes',
      ...(hc ? { hc } : {}),
      ...(shimDir ? { shimDir } : {}),
    },
  };
}
