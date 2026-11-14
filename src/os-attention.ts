/**
 * Pure decision module for OS-level attention routing.
 *
 * Determines whether the host should raise OS-level attention (taskbar flash,
 * OS notification) for a session that just finished work. Kept pure (no Electron
 * imports) so it is fully unit-testable without any host context.
 */

import type { ServerEvents } from './contracts/server-protocol';

export interface OsAttentionInput {
  /** The session just transitioned from busy -> needs-attention (the edge). */
  becameNeedsAttention: boolean;
  /** Whether the Conduit window currently has OS focus. */
  windowFocused: boolean;
  /** Whether the osAttention setting is enabled by the user. */
  enabled: boolean;
}

/**
 * Returns true when OS-level attention should be raised.
 *
 * Fires only on the busy->needs-attention EDGE (becameNeedsAttention), only
 * when the window is NOT focused (no point alerting an already-focused user),
 * and only when the user has the feature enabled.
 */
export function shouldRaiseOsAttention(input: OsAttentionInput): boolean {
  return input.enabled && input.becameNeedsAttention && !input.windowFocused;
}

/**
 * The OS notification text. Built from the session name and the edge only: agent text never
 * reaches an OS notice (spec §4.5).
 */
export function attentionBody(
  name: string,
  edge: Pick<ServerEvents['attention.edge'], 'kind' | 'requestKind' | 'count'>,
): string {
  if (edge.kind === 'run-end') return `${name} finished`;
  if (edge.kind === 'request') {
    if (edge.count !== undefined && edge.count > 1) return `${edge.count} new requests need you`;
    switch (edge.requestKind) {
      case 'attend':
        return `${name} is waiting at a prompt`;
      case 'confirm':
        return `${name} needs your approval`;
      case 'review':
        return `${name} asks you to review`;
      case 'choose':
      case 'text':
        return `${name} asks you a question`;
      default:
        return `${name} is waiting`;
    }
  }
  return `${name} is waiting`;
}
