import type {
  NativeLaunchFailure,
  NativeLaunchIntent,
  NativeSelection,
} from './contracts/native-launch';
import { commandLeaf } from './launch-args';
import type { HostPlatform } from './lsp-binary';
import { coerceModel } from './session-command';
import type { AgentDefinition, SpawnSpec } from './types';

export type NativeLaunchPreparation =
  | { ok: true; spec: SpawnSpec; intent?: NativeLaunchIntent }
  | { ok: false; problem: Exclude<NativeLaunchFailure, 'save-failed'> };

const CONFLICT_FLAGS = {
  claude: new Set([
    '--permission-mode',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--settings',
    '--setting-sources',
    '--tools',
    '--allowedTools',
    '--allowed-tools',
    '--disallowedTools',
    '--disallowed-tools',
    '--permission-prompt-tool',
  ]),
  codex: new Set([
    '-s',
    '--sandbox',
    '-a',
    '--ask-for-approval',
    '-c',
    '--config',
    '-p',
    '--profile',
    '--full-auto',
    '--dangerously-bypass-approvals-and-sandbox',
    '--yolo',
    '--enable',
    '--disable',
  ]),
};

export function prepareNativeLaunch(
  selection: NativeSelection,
  def: Pick<AgentDefinition, 'command' | 'args'>,
  spec: SpawnSpec,
  platform: HostPlatform,
): NativeLaunchPreparation {
  if (selection.status === 'unavailable') return { ok: false, problem: 'policy-unavailable' };
  const { intent } = selection;
  if (intent.requested === null) return { ok: true, spec, intent };

  if (
    def.args.some((arg) => {
      const flag = arg.split('=', 1)[0];
      return (
        CONFLICT_FLAGS[intent.family].has(flag) ||
        (intent.family === 'codex' && /^-[sacp][^-]/.test(flag))
      );
    })
  )
    return { ok: false, problem: 'conflict' };

  const direct = (command: string): boolean =>
    commandLeaf(command) === intent.family &&
    !/\.bat$/i.test(command) &&
    (platform === 'win32' || !/\.(cmd|exe)$/i.test(command));
  const modelFlag = intent.family === 'claude' ? '--model' : '-m';
  const validArgs =
    def.args.length === 0 ||
    (def.args.length === 2 && def.args[0] === modelFlag && coerceModel(def.args[1]) !== undefined);
  if (!direct(def.command) || !direct(spec.command) || !validArgs)
    return { ok: false, problem: 'unsupported' };

  const prefix =
    intent.family === 'claude'
      ? ['--permission-mode', intent.requested.mode]
      : ['--sandbox', intent.requested.sandbox, '--ask-for-approval', intent.requested.approval];
  return { ok: true, spec: { ...spec, args: [...prefix, ...spec.args] }, intent };
}
