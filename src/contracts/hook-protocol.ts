// Claude Code hook client → server, one line on the MCP endpoint socket. Distinguished from a C6
// shim hello by its `conduitHook` key, so the frozen C6 contract is untouched.
// Client: resources/conduit-mcp/conduit-hook.cjs. see docs/specs/2026-11-13-scheduler-auto-resume.md §3

export type HookEvent = 'StopFailure' | 'UserPromptSubmit' | 'Stop' | 'Notification' | 'StatusLine';

export interface HookPost {
  conduitHook: 1;
  token: string;
  event: HookEvent;
  payload: unknown;
}

/** The server answers one ack line and closes. */
export type HookAck = { conduitHook: 1; ok: boolean };

export const HOOK_POST_MAX_BYTES = 256 * 1024;
