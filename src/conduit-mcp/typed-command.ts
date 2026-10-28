import type { AgentCli } from './install-types';

export const DETECT_GRACE_MS = 15_000;
/** Spec §2.4 D-F6: how long after a typed CLI line an untyped Enter still answers that CLI. */
export const UNTYPED_ENTER_KEEP_MS = 60_000;
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

export interface TypedEnter {
  /** The agent CLI the line ran, else null (also for a line edited out of sight). */
  cli: AgentCli | null;
  /**
   * The line held a printable typed character. An Enter alone, or after arrow keys only, answers a
   * CLI's own dialog (trust, login, a picker) rather than running a command (spec §2.4 A1).
   */
  typed: boolean;
}

export interface TypedLineTracker {
  /** One entry per Enter in data, in order. */
  feed(data: string): TypedEnter[];
}

// We only see keystrokes, not the shell's line buffer: anything that edits the line out of our sight
// (history, completion, cursor moves, paste) makes it unknown rather than guessed (spec D4).
export function createTypedLineTracker(): TypedLineTracker {
  let line = '';
  let known = true;
  let typed = false;
  let afterCr = false;
  // An escape sequence's own bytes (the `[B` of an arrow key) were not typed.
  let esc: 'none' | 'start' | 'csi' | 'ss3' = 'none';
  return {
    feed(data) {
      const out: TypedEnter[] = [];
      for (const ch of data) {
        // A control character inside a sequence still acts, as it does in a terminal.
        if (esc !== 'none' && ch >= ' ') {
          if (esc === 'start') esc = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none';
          else if (esc === 'ss3' || (ch >= '@' && ch <= '~')) esc = 'none';
          continue;
        }
        esc = 'none';
        const crlf = afterCr && ch === '\n';
        afterCr = ch === '\r';
        if (crlf) continue;
        if (ch === '\r' || ch === '\n') {
          out.push({ cli: known ? agentCliOfLine(line) : null, typed });
          line = '';
          known = true;
          typed = false;
        } else if (ch === '\x03' || ch === '\x15') {
          line = '';
          known = true;
          typed = false;
        } else if (ch === '\x1b') {
          known = false;
          esc = 'start';
        } else if (ch === '\t') {
          known = false;
        } else if (ch === '\x7f' || ch === '\b') {
          line = line.slice(0, -1);
        } else if (ch >= ' ') {
          line += ch;
          typed = true;
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
