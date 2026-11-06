export const STOP_ALL_AGENTS_FLAG = '--stop-all-agents';

export function jumpListTasks(execPath: string): Electron.Task[] {
  return [
    {
      program: execPath,
      arguments: STOP_ALL_AGENTS_FLAG,
      title: 'Stop all agents…',
      description: 'Stop every agent Conduit is running in the background',
      iconPath: execPath,
      iconIndex: 0,
    },
  ];
}

export async function runStopAllAgents(deps: {
  confirm(): Promise<boolean>;
  stopAll(): Promise<{ ok: boolean; reason?: string }>;
  error(message: string): Promise<void>;
  secondInstanceArrived(): boolean;
}): Promise<'quit' | 'relaunch'> {
  if (await deps.confirm()) {
    const result = await deps.stopAll();
    if (!result.ok) await deps.error(result.reason ?? 'The agents could not be stopped.');
  }
  return deps.secondInstanceArrived() ? 'relaunch' : 'quit';
}
