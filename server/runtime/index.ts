import type { HcClient } from '../../src/contracts/hc';
import type { ServerEventSink, TokenStorePort } from '../../src/contracts/server-ports';
import { ServerAttention } from '../attention';
import { diskScrollbackFiles, type ScrollbackFiles, ServerScrollback } from '../scrollback';
import { HcTerminalRuntime } from './runtime';
import { createTyping } from './typing';

export { HcTerminalRuntime } from './runtime';

export interface RuntimeServicesDeps {
  hc: HcClient;
  tokens: TokenStorePort;
  emit: ServerEventSink;
  instance: string;
  hcSession: string;
  appVersion: string;
  logPath: string;
  /** userData: where scrollback-<id>.json files live. */
  userData: string;
  /** ServerSettings.scrollbackPersistence, read per write. */
  recording(): boolean;
  log(message: string): void;
  files?: ScrollbackFiles;
}

/** W6's half of server/compose.ts: C1 plus the C7 ports it provides. */
export function createRuntimeServices(deps: RuntimeServicesDeps) {
  let runtime: HcTerminalRuntime | undefined;
  const scrollback = new ServerScrollback({
    files: deps.files ?? diskScrollbackFiles(deps.userData, deps.log),
    emit: deps.emit,
    sizeOf: (id) => runtime?.get(id)?.size ?? runtime?.lastSizeOf(id),
    recording: deps.recording,
  });
  runtime = new HcTerminalRuntime({
    hc: deps.hc,
    tokens: deps.tokens,
    ring: scrollback,
    instance: deps.instance,
    hcSession: deps.hcSession,
    appVersion: deps.appVersion,
    logPath: deps.logPath,
    log: deps.log,
  });
  const attention = new ServerAttention({ runtime });
  return {
    runtime,
    typing: createTyping(runtime),
    screens: runtime.screens,
    attention,
    scrollback,
  };
}
