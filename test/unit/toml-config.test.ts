import { describe, expect, it } from 'vitest';
import { type CodexEntry, ConfigFormatError } from '../../src/conduit-mcp/install-types';
import {
  locateConduitTable,
  readCodexConduit,
  renderCodexTable,
  spliceConduitTable,
  tomlBasicString,
} from '../../src/conduit-mcp/toml-config';

const ENTRY: CodexEntry = {
  command: '/app/conduit',
  args: ['/app/res/conduit-mcp-shim.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  env_vars: ['CONDUIT_SESSION_TOKEN', 'CONDUIT_MCP_ENDPOINT'],
  default_tools_approval_mode: 'auto',
  tool_timeout_sec: 180,
};

const TABLE = [
  '[mcp_servers.conduit]',
  'command = "/app/conduit"',
  'args = ["/app/res/conduit-mcp-shim.cjs"]',
  'env = { ELECTRON_RUN_AS_NODE = "1" }',
  'env_vars = ["CONDUIT_SESSION_TOKEN", "CONDUIT_MCP_ENDPOINT"]',
  'default_tools_approval_mode = "auto"',
  'tool_timeout_sec = 180',
  '',
].join('\n');

const OLD =
  '[mcp_servers.conduit]\ncommand = "/old/conduit"\nargs = ["/old/conduit-mcp-shim.cjs"]\n';

interface Case {
  name: string;
  input: string;
  entry: CodexEntry | null;
  expected?: string;
  errorCode?: string;
}

const CASES: Case[] = [
  {
    name: 'absent + entry → appended with no separator line, so uninstall is exact',
    input: 'model = "o3"\n',
    entry: ENTRY,
    expected: `model = "o3"\n${TABLE}`,
  },
  {
    name: 'absent + entry, no trailing newline → newline then the table',
    input: 'model = "o3"',
    entry: ENTRY,
    expected: `model = "o3"\n${TABLE}`,
  },
  {
    name: 'absent + entry, already ends in a blank line → the user’s blank line kept, none added',
    input: 'model = "o3"\n\n',
    entry: ENTRY,
    expected: `model = "o3"\n\n${TABLE}`,
  },
  { name: 'empty file + entry → just the table', input: '', entry: ENTRY, expected: TABLE },
  {
    name: 'absent + entry after other servers',
    input: '[mcp_servers.other]\ncommand = "x"\n',
    entry: ENTRY,
    expected: `[mcp_servers.other]\ncommand = "x"\n${TABLE}`,
  },
  { name: 'absent + remove → unchanged', input: 'a = 1\n', entry: null, expected: 'a = 1\n' },
  {
    name: 'replace keeps the comment lines above the next header (they are not ours)',
    input: `top = 1\n\n${OLD}# trailing\n\n[profiles.x]\nmodel = "y"\n`,
    entry: ENTRY,
    expected: `top = 1\n\n${TABLE}# trailing\n\n[profiles.x]\nmodel = "y"\n`,
  },
  {
    name: 'remove keeps a comment block and blank lines before the next header',
    input: `a = 1\n\n${OLD}\n# profiles below\n  # second\n\n[profiles.x]\nm = 1\n`,
    entry: null,
    expected: 'a = 1\n\n\n# profiles below\n  # second\n\n[profiles.x]\nm = 1\n',
  },
  {
    name: 'trailing comments at EOF stay',
    input: `${OLD}# end\n`,
    entry: ENTRY,
    expected: `${TABLE}# end\n`,
  },
  {
    name: 'a comment between our keys stays inside the range',
    input: `${OLD.replace('\nargs', '\n# mine\nargs')}\n[p]\nx = 1\n`,
    entry: ENTRY,
    expected: `${TABLE}\n[p]\nx = 1\n`,
  },
  {
    name: 'replace at EOF without a trailing newline',
    input: 'top = 1\n\n[mcp_servers.conduit]\ncommand = "/old/conduit"',
    entry: ENTRY,
    expected: `top = 1\n\n${TABLE}`,
  },
  {
    name: 'table + contiguous [mcp_servers.conduit.env] subtable → both replaced',
    input: `${OLD}\n[mcp_servers.conduit.env]\nFOO = "1"\n\n[profiles.x]\nm = 1\n`,
    entry: ENTRY,
    expected: `${TABLE}\n[profiles.x]\nm = 1\n`,
  },
  {
    name: 'table + contiguous subtable → both removed',
    input: `a = 1\n\n${OLD}[mcp_servers.conduit.env]\nFOO = "1"\n\n[profiles.x]\nm = 1\n`,
    entry: null,
    expected: 'a = 1\n\n\n[profiles.x]\nm = 1\n',
  },
  {
    name: 'quoted header [mcp_servers."conduit"] with a comment → located',
    input: `[ mcp_servers . "conduit" ] # mine\ncommand = "/old"\n\n[other]\nx = 1\n`,
    entry: ENTRY,
    expected: `${TABLE}\n[other]\nx = 1\n`,
  },
  {
    name: 'remove → only the range deleted',
    input: `[mcp_servers]\n\n${OLD}\n[mcp_servers.other]\ncommand = "x"\n`,
    entry: null,
    expected: '[mcp_servers]\n\n\n[mcp_servers.other]\ncommand = "x"\n',
  },
  {
    name: 'remove a hand-written table after the user’s blank line → that blank line stays',
    input: `a = 1\n\n${OLD}`,
    entry: null,
    expected: 'a = 1\n\n',
  },
  {
    name: 'CRLF file → inserted lines use CRLF',
    input: 'model = "o3"\r\n',
    entry: ENTRY,
    expected: `model = "o3"\r\n${TABLE.replaceAll('\n', '\r\n')}`,
  },
  {
    name: 'CRLF replace keeps the following bytes',
    input: `${OLD.replaceAll('\n', '\r\n')}\r\n[p]\r\nx = 1\r\n`,
    entry: ENTRY,
    expected: `${TABLE.replaceAll('\n', '\r\n')}\r\n[p]\r\nx = 1\r\n`,
  },
  {
    name: 'dotted mcp_servers.conduit.command at the root → EUNEDITABLE',
    input: 'mcp_servers.conduit.command = "x"\n',
    entry: ENTRY,
    errorCode: 'EUNEDITABLE',
  },
  {
    name: 'dotted conduit.command under [mcp_servers] → EUNEDITABLE',
    input: '[mcp_servers]\nconduit.command = "x"\n',
    entry: null,
    errorCode: 'EUNEDITABLE',
  },
  {
    name: 'inline conduit = { command = "x" } under [mcp_servers] → EUNEDITABLE',
    input: '[mcp_servers]\nconduit = { command = "x" }\n',
    entry: ENTRY,
    errorCode: 'EUNEDITABLE',
  },
  {
    name: 'header plus dotted keys from [mcp_servers] is invalid TOML → ETOML',
    input: '[mcp_servers]\nconduit.env.A = "1"\n\n[mcp_servers.conduit]\ncommand = "x"\n',
    entry: ENTRY,
    errorCode: 'ETOML',
  },
  {
    name: 'non-contiguous [mcp_servers.conduit.env] after another table → EUNEDITABLE',
    input: `${OLD}\n[profiles.x]\nm = 1\n\n[mcp_servers.conduit.env]\nFOO = "1"\n`,
    entry: ENTRY,
    errorCode: 'EUNEDITABLE',
  },
  {
    name: 'subtable before its parent header → EUNEDITABLE',
    input: `[mcp_servers.conduit.env]\nFOO = "1"\n\n[p]\nx = 1\n\n${OLD}`,
    entry: ENTRY,
    errorCode: 'EUNEDITABLE',
  },
  {
    name: 'only a subtable header → EUNEDITABLE',
    input: '[mcp_servers.conduit.env]\nFOO = "1"\n',
    entry: ENTRY,
    errorCode: 'EUNEDITABLE',
  },
  {
    name: '[[mcp_servers.conduit.x]] array → EUNEDITABLE',
    input: `${OLD}[[mcp_servers.conduit.x]]\na = 1\n`,
    entry: ENTRY,
    errorCode: 'EUNEDITABLE',
  },
  {
    name: 'multi-line string with header-like text inside the conduit range → EGUARD',
    input: `${OLD}note = """\n[mcp_servers.other]\nstill a string\n"""\n`,
    entry: ENTRY,
    errorCode: 'EGUARD',
  },
  {
    name: 'a string line that only starts like a header does not end the range',
    input: `${OLD}note = """\n[mcp_servers.other] is not a header\n"""\n\n[p]\nx = 1\n`,
    entry: ENTRY,
    expected: `${TABLE}\n[p]\nx = 1\n`,
  },
  {
    name: 'header-like text in a string whose splice still parses but adds a server → EGUARD',
    input: `${OLD}note = '''\n[mcp_servers.other]\ny = 1 # '''\n`,
    entry: ENTRY,
    errorCode: 'EGUARD',
  },
  {
    name: 'mcp_servers is not a table → EGUARD on append',
    input: 'mcp_servers = 3\n',
    entry: ENTRY,
    errorCode: 'EGUARD',
  },
  { name: 'invalid TOML → ETOML', input: 'a = \n', entry: ENTRY, errorCode: 'ETOML' },
  { name: 'invalid TOML on remove → ETOML', input: '[a\n', entry: null, errorCode: 'ETOML' },
];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ConfigFormatError ? e.code : `not-ConfigFormatError:${String(e)}`;
  }
  return undefined;
}

describe('toml-config', () => {
  it.each(CASES)('splice: $name', ({ input, entry, expected, errorCode }) => {
    if (errorCode !== undefined) {
      expect(codeOf(() => spliceConduitTable(input, entry))).toBe(errorCode);
      return;
    }
    const out = spliceConduitTable(input, entry);
    expect(out).toBe(expected);
    if (entry !== null) expect(readCodexConduit(out)).toEqual(entry);
    else expect(readCodexConduit(out)).toBeUndefined();
  });

  it.each([
    'a = 1\n',
    'a = 1\n\n',
    'a = 1\r\n',
    'a = 1\r\n\r\n',
    '# head\r\nmodel = "o3"\r\n',
    '[profiles.x]\nm = 1\n',
    '[profiles.x]\r\nm = 1\r\n\r\n',
    '[mcp_servers.other]\ncommand = "x"\n',
    '\n',
    '',
  ])('QA F3 install → uninstall restores the file byte for byte: %j', (input) => {
    expect(spliceConduitTable(spliceConduitTable(input, ENTRY), null)).toBe(input);
  });

  it('install → uninstall of a file without a final EOL keeps the EOL install added', () => {
    expect(spliceConduitTable(spliceConduitTable('a = 1', ENTRY), null)).toBe('a = 1\n');
    expect(spliceConduitTable(spliceConduitTable('# c', ENTRY), null)).toBe('# c\n');
  });

  it('absent + entry: every original byte is a prefix of the output', () => {
    const input = '# head\r\nmodel = "o3" # c\r\n[profiles.x]\r\nm = 1';
    expect(spliceConduitTable(input, ENTRY).startsWith(input)).toBe(true);
  });

  it('locateConduitTable reports absent, the line range, or uneditable', () => {
    expect(locateConduitTable('a = 1\n')).toEqual({ kind: 'absent' });
    expect(locateConduitTable(`a = 1\n\n${OLD}\n\n[p]\n`)).toEqual({
      kind: 'range',
      start: 2,
      end: 5,
    });
    expect(locateConduitTable('[mcp_servers]\nconduit = {}\n')).toEqual({ kind: 'uneditable' });
    expect(codeOf(() => locateConduitTable('= ='))).toBe('ETOML');
  });

  it('tomlBasicString escapes backslash, quote and controls', () => {
    expect(tomlBasicString('C:\\a"b\n')).toBe('"C:\\\\a\\"b\\u000A"');
    expect(tomlBasicString('\u0000\u001f\u007f é')).toBe('"\\u0000\\u001F\\u007F é"');
  });

  it('renderCodexTable round-trips through readCodexConduit to the entry', () => {
    expect(renderCodexTable(ENTRY, '\n')).toBe(TABLE);
    const winEntry: CodexEntry = {
      ...ENTRY,
      command: 'C:\\Program Files\\Conduit\\Conduit.exe',
      args: ['C:\\Users\\a"b\\resources\\conduit-mcp-shim.cjs'],
    };
    const crlf = renderCodexTable(winEntry, '\r\n');
    expect(crlf.endsWith('\r\n')).toBe(true);
    expect(crlf.split('\r\n')).toHaveLength(8);
    expect(readCodexConduit(crlf)).toEqual(winEntry);
  });

  it('readCodexConduit: undefined when absent or mcp_servers is not a table; ETOML on bad text', () => {
    expect(readCodexConduit('')).toBeUndefined();
    expect(readCodexConduit('[mcp_servers.other]\ncommand = "x"\n')).toBeUndefined();
    expect(readCodexConduit('mcp_servers = 3\n')).toBeUndefined();
    expect(readCodexConduit('[mcp_servers]\nconduit = "x"\n')).toBe('x');
    expect(codeOf(() => readCodexConduit('a = '))).toBe('ETOML');
  });
});
