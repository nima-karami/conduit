import { commandLeaf } from '../launch-args';
import type { AgentDefinition } from '../types';

export type McpAdapterId = 'claude' | 'codex' | 'cursor' | 'fake';
/** emptyInput [] ⇒ never 'empty-input' ⇒ pull-only. */
export interface ScreenPatterns {
  blocking: readonly RegExp[];
  /** The bare prompt, matched on the cursor row after placeholder-styled cells are dropped. */
  emptyInput: readonly RegExp[];
  /** How the CLI styles placeholder text in its input row; those cells are never input. */
  placeholder?: 'dim';
  /** Known placeholder texts, for snapshots without styles only. */
  placeholderText?: readonly RegExp[];
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
      placeholderText: [/^\s*❯\s+Try ".*"\s*$/],
    },
    e2eOnly: false,
  },
  {
    // Idle row measured in Conduit (fixture codex-idle). placeholderText lists Codex's rotating
    // composer examples; an approval replaces the composer, so it never reads as empty.
    id: 'codex',
    leaves: ['codex'],
    ids: [],
    wiring: 'codex-c-flags',
    screen: {
      blocking: [/enter continue · esc quit/i, /enter to confirm or esc to cancel/i],
      emptyInput: [/^\s*›\s*$/],
      placeholder: 'dim',
      placeholderText: [
        /^\s*›\s+(Ask Codex to do anything|Explain this codebase|Summarize recent commits|Implement \{feature\}|(Find and fix a bug in|Write tests for|Improve documentation in) @filename|Run \/review on my current changes|Use \/skills to list available skills)\s*$/,
      ],
    },
    e2eOnly: false,
  },
  {
    id: 'cursor',
    leaves: ['agent', 'cursor-agent'],
    ids: [],
    wiring: 'cursor-global',
    screen: null,
    e2eOnly: false,
  },
  {
    id: 'fake',
    leaves: [],
    ids: ['e2e-fake-mcp'],
    wiring: 'mcp-config-flag',
    screen: { blocking: [/Esc to cancel/], emptyInput: [/^fake❯\s*$/] },
    e2eOnly: true,
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
