// Fixed ASCII with no digits and no peer text: docs/specs/2026-10-25-conduit-mcp-server.md §2.
export function composeNotice(urgent: boolean): string {
  return `[conduit] New messages for you${urgent ? ' (urgent)' : ''}. Use the conduit read_inbox tool.`;
}
