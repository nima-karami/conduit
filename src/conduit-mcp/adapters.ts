import { commandLeaf } from '../launch-args';
import type { AgentDefinition } from '../types';

export type McpAdapterId = 'claude' | 'codex' | 'cursor' | 'fake';
export interface ScreenPatterns {
  /** Matched on every viewport row. */
  blocking: readonly RegExp[];
  /**
   * The bare prompt, matched on the input row once a placeholder is dropped (screenVerdict).
   * [] ⇒ never 'empty-input' ⇒ pull-only.
   */
  emptyInput: readonly RegExp[];
  /** Locates the input box when the cursor parks away from it; see screen-verdict.ts. */
  inputRow?: { pattern: RegExp; maxAbove: number };
  /** How the CLI draws its input placeholder and suggested prompt; absent ⇒ never dropped. */
  placeholder?: 'dim';
  /**
   * Where the input box starts, for keeping it out of terminal link detection, when `inputRow`
   * doesn't already say (spec 2026-10-27-input-box-links §3).
   */
  inputBox?: { pattern: RegExp; maxAbove: number };
}
// Brief support: docs/specs/2026-10-26-conduit-role-brief.md §3.2
export interface BriefSupport {
  readAccess: 'add-dir' | 'none';
}
export type McpWiringKind = 'mcp-config-flag' | 'codex-c-flags' | 'cursor-global';
export interface McpAdapter {
  id: McpAdapterId;
  /** commandLeaf() values */
  leaves: readonly string[];
  /** Agent-definition ids */
  ids: readonly string[];
  wiring: McpWiringKind;
  /** null ⇒ pull-only */
  screen: ScreenPatterns | null;
  e2eOnly: boolean;
  brief: BriefSupport | null;
}

// Patterns come from the captured screens in test/unit/fixtures/conduit-mcp/screens/
// (docs/runs/2026-10-25-conduit-mcp/s0-screens.md). Claude renders the space after ❯ as U+00A0,
// hence \s rather than a literal space. Placeholder styles: docs/runs/2026-10-26-conduit-mcp/
// placeholder-cells.md.
export const MCP_ADAPTERS: readonly McpAdapter[] = [
  {
    id: 'claude',
    leaves: ['claude'],
    ids: [],
    wiring: 'mcp-config-flag',
    screen: {
      blocking: [/Esc to cancel/, /^\s*❯\s*\d+\.\s/],
      emptyInput: [/^\s*❯\s*$/],
      placeholder: 'dim',
    },
    e2eOnly: false,
    brief: { readAccess: 'add-dir' },
  },
  {
    // Idle row measured in Conduit (fixture codex-idle). An approval replaces the composer, so it
    // never reads as empty.
    id: 'codex',
    leaves: ['codex'],
    ids: [],
    wiring: 'codex-c-flags',
    screen: {
      blocking: [/enter continue · esc quit/i, /enter to confirm or esc to cancel/i],
      emptyInput: [/^\s*›\s*$/],
      placeholder: 'dim',
      // A multi-line draft moves the cursor below the `›` row.
      inputBox: { pattern: /^\s*›/, maxAbove: 8 },
    },
    e2eOnly: false,
    brief: { readAccess: 'none' },
  },
  {
    id: 'cursor',
    leaves: ['agent', 'cursor-agent'],
    ids: [],
    // Cursor parks the cursor 5-6 rows below its `→` input row (S0, spec §3.4), so the row is
    // located by pattern; maxAbove adds a wrap allowance.
    wiring: 'cursor-global',
    screen: {
      inputRow: { pattern: /^\s*→/, maxAbove: 8 },
      emptyInput: [/^\s*→\s*(Plan, search, build anything|Add a follow-up)?\s*$/],
      blocking: [
        /Use arrow keys to navigate, Enter to select/,
        /MCP Server Approval Required/,
        /Run this (MCP tool|command)\?/,
        /^\s*→ Run \(once\) \(y\)/,
        /Esc to close\s*$/,
      ],
    },
    e2eOnly: false,
    brief: { readAccess: 'none' },
  },
  {
    id: 'fake',
    leaves: [],
    ids: ['e2e-fake-mcp'],
    wiring: 'mcp-config-flag',
    screen: { blocking: [/Esc to cancel/], emptyInput: [/^fake❯\s*$/] },
    e2eOnly: true,
    brief: { readAccess: 'none' },
  },
];

export function adapterFor(
  def: Pick<AgentDefinition, 'id' | 'command'>,
  opts: { e2e: boolean },
): McpAdapter | undefined {
  const leaf = commandLeaf(def.command);
  return MCP_ADAPTERS.find(
    (a) => (opts.e2e || !a.e2eOnly) && (a.ids.includes(def.id) || a.leaves.includes(leaf)),
  );
}

export function notifiable(a: McpAdapter): boolean {
  return a.screen !== null && a.screen.emptyInput.length > 0;
}
