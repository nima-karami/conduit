import type { AgentCli } from './install-types';

export const DETECT_GRACE_MS = 15_000;
/** Spec §2.5: invocations that never start an MCP client, so no initialize is expected. */
export const NON_INTERACTIVE_ARGS: readonly string[] = [
  '--version',
  '-v',
  '--help',
  '-h',
  'mcp',
  'update',
  'doctor',
  'login',
  'logout',
  'config',
  'exec',
  '-p',
  '--print',
  'run',
];

const CLI_OF_LEAF: Readonly<Record<string, AgentCli>> = {
  claude: 'claude',
  codex: 'codex',
  agent: 'cursor',
  'cursor-agent': 'cursor',
  opencode: 'opencode',
};

export interface TypedLineTracker {
  /** One entry per Enter in data, in order: the agent CLI that line ran, else null. */
  feed(data: string): (AgentCli | null)[];
}

// We only see keystrokes, not the shell's line buffer: anything that edits the line out of our sight
// (history, completion, cursor moves, paste) makes it unknown rather than guessed (spec D4).
export function createTypedLineTracker(): TypedLineTracker {
  let line = '';
  let known = true;
  let afterCr = false;
  return {
    feed(data) {
      const out: (AgentCli | null)[] = [];
      for (const ch of data) {
        const crlf = afterCr && ch === '\n';
        afterCr = ch === '\r';
        if (crlf) continue;
        if (ch === '\r' || ch === '\n') {
          out.push(known ? agentCliOfLine(line) : null);
          line = '';
          known = true;
        } else if (ch === '\x03' || ch === '\x15') {
          line = '';
          known = true;
        } else if (ch === '\x1b' || ch === '\t') {
          known = false;
        } else if (ch === '\x7f' || ch === '\b') {
          line = line.slice(0, -1);
        } else if (ch >= ' ') {
          line += ch;
        }
      }
      return out;
    },
  };
}

function tokens(line: string): string[] {
  const rest = line.trimStart();
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const close = rest.indexOf(quote, 1);
    if (close !== -1) {
      return [
        rest.slice(1, close),
        ...rest
          .slice(close + 1)
          .trim()
          .split(/\s+/),
      ];
    }
  }
  return rest.trim().split(/\s+/);
}

export function agentCliOfLine(line: string): AgentCli | null {
  const [first = '', second = ''] = tokens(line);
  const leaf = (first.split(/[/\\]/).pop() ?? '')
    .replace(/\.(exe|cmd|ps1|bat)$/i, '')
    .toLowerCase();
  if (!Object.hasOwn(CLI_OF_LEAF, leaf)) return null;
  if (NON_INTERACTIVE_ARGS.includes(second.toLowerCase())) return null;
  return CLI_OF_LEAF[leaf] ?? null;
}
