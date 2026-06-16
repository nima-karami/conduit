/**
 * Pure decision module for OS-level attention routing.
 *
 * Determines whether the host should raise OS-level attention (taskbar flash,
 * OS notification) for a session that just finished work. Kept pure (no Electron
 * imports) so it is fully unit-testable without any host context.
 */

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
