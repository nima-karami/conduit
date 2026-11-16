import { argValue } from './cli-args';

/** How the core and supervisor are started on this machine; decided by the probe (plan decision 4). */
const START_METHODS = ['scope', 'plain', 'windows-task'] as const;
export type StartMethod = (typeof START_METHODS)[number];

export interface EnsureArgs {
  userData: string;
  method: StartMethod;
  /** Decided by the caller from the probe: linger, KillUserProcesses. Reported back, not checked here. */
  survivesLogout: boolean;
  hc?: string;
}

const ENSURE_USAGE =
  'usage: main.js --ensure-server --user-data <dir> --start scope|plain|windows-task --survives-logout yes|no [--hc <path>]';

export type EnsureArgsResult = { ok: true; args: EnsureArgs } | { ok: false; error: string };

/** A missing or unknown value is a usage error: the caller must choose the method, never default it. */
export function parseEnsureArgs(args: readonly string[]): EnsureArgsResult {
  const userData = argValue(args, '--user-data');
  if (!userData) return { ok: false, error: `missing --user-data\n${ENSURE_USAGE}` };
  const start = argValue(args, '--start');
  if (!start || !(START_METHODS as readonly string[]).includes(start))
    return {
      ok: false,
      error: `--start must be one of ${START_METHODS.join(', ')}\n${ENSURE_USAGE}`,
    };
  const survives = argValue(args, '--survives-logout');
  if (survives !== 'yes' && survives !== 'no')
    return { ok: false, error: `--survives-logout must be yes or no\n${ENSURE_USAGE}` };
  const hc = argValue(args, '--hc');
  return {
    ok: true,
    args: {
      userData,
      method: start as StartMethod,
      survivesLogout: survives === 'yes',
      ...(hc ? { hc } : {}),
    },
  };
}
