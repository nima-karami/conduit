import { SUPERVISOR_TRAY_FLAGS } from '../../src/contracts/tray-protocol';
import type { TrayArgs } from './contracts';

type TrayFlag = (typeof SUPERVISOR_TRAY_FLAGS)[number];

const isTrayFlag = (arg: string): arg is TrayFlag =>
  (SUPERVISOR_TRAY_FLAGS as readonly string[]).includes(arg);

/**
 * Every tray flag always takes the next arg as its value, even one that starts with `--`: a dev
 * `--app-arg --e2e` must never reach the server's `args.includes('--e2e')` (spec §6 Argv).
 */
export function splitSupervisorArgs(args: readonly string[]): {
  tray: TrayArgs | null;
  rest: string[];
} {
  const rest: string[] = [];
  const values: Record<TrayFlag, string[]> = {
    '--tray': [],
    '--app-exe': [],
    '--app-arg': [],
    '--app-cwd': [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (isTrayFlag(arg)) {
      if (i + 1 < args.length) values[arg].push(args[i + 1]);
      i += 1;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : '';
    if (isTrayFlag(flag)) {
      values[flag].push(arg.slice(eq + 1));
      continue;
    }
    rest.push(arg);
  }
  const source = values['--tray'].at(-1);
  if (!source) return { tray: null, rest };
  const exe = values['--app-exe'].at(-1);
  const cwd = values['--app-cwd'].at(-1);
  return {
    tray: { source, app: exe && cwd ? { exe, args: values['--app-arg'], cwd } : null },
    rest,
  };
}

/** The packaged app always passes `--shim-dir`, so this holds only for a dev build (spec §14 seam gate). */
export const seamEnabled = (rest: readonly string[]) =>
  rest.includes('--e2e') && !rest.includes('--shim-dir');
