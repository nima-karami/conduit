import type { HcMethods } from '../../src/contracts/hc';
import type { InstanceNames } from '../../src/contracts/session-identity';

/** The slice of `HcClient` a poll needs; a real `HcClient` satisfies it. */
export interface PollClient {
  call(
    method: 'terminal.list',
    params: HcMethods['terminal.list']['params'],
  ): Promise<{ terminals: readonly { state: string }[] }>;
  close(): void;
}

/**
 * F2 fallback reading: live session terminals of this instance, labelled as `directStopAll` lists
 * them (`server/hc-cli.ts`). Connected per poll, like `supervisorCore`, so a core restart never has
 * one more long-lived client to drop. null = no reading; the relay keeps its previous one.
 */
export async function pollRunning(
  connect: () => PollClient,
  names: Pick<InstanceNames, 'instance'>,
  log: (message: string) => void,
): Promise<number | null> {
  let hc: PollClient;
  try {
    hc = connect();
  } catch (error) {
    log(`tray hc poll: connect failed: ${String(error)}`);
    return null;
  }
  try {
    const { terminals } = await hc.call('terminal.list', {
      labels: { 'conduit.instance': names.instance, 'conduit.role': 'session' },
    });
    return terminals.filter((t) => t.state === 'live').length;
  } catch (error) {
    log(`tray hc poll: terminal.list failed: ${String(error)}`);
    return null;
  } finally {
    hc.close();
  }
}
