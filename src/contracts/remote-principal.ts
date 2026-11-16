// see docs/specs/2026-11-14-conduit-network.md §4.1 and policy-and-permissions §4.3 (R1)
export type Capability = 'messaging' | 'monitor' | 'drive';
export type Capabilities = Record<Capability, boolean>;
/** A caller on an own-linked server. Address form: `${handle}@${machineId}`. */
export interface RemotePrincipal {
  kind: 'remote';
  handle: string /* 'claude-3' | 'you' */;
  machineId: string /* /^m-[0-9a-f]{8}$/ */;
  trust: 'own';
  /** The ssh controller of an inbound link: the only peer that may run orchestrate tools. see docs/plans/2026-11-16-remote-ssh-routed-tools.plan.md §2 */
  controller: boolean;
}
export const principalAddress = (p: RemotePrincipal): string => `${p.handle}@${p.machineId}`;
