// Shared by the TS and .cjs precedence tests, so both copies are checked against one set of cases.
export interface StatusLineCase {
  name: string;
  files: { local?: unknown; shared?: unknown; user?: unknown };
  expect: string | null;
}

const sl = (command: string) => ({ statusLine: { type: 'command', command } });

export const STATUS_LINE_CASES: readonly StatusLineCase[] = [
  {
    name: 'the project local file wins over the shared project file and the user file',
    files: { local: sl('local'), shared: sl('shared'), user: sl('user') },
    expect: 'local',
  },
  {
    name: 'the shared project file wins over the user file',
    files: { shared: sl('shared'), user: sl('user') },
    expect: 'shared',
  },
  { name: 'falls back to the user config file', files: { user: sl('user') }, expect: 'user' },
  {
    name: 'skips a file whose statusLine is not a command',
    files: { local: { statusLine: { type: 'other', command: 'x' } }, user: sl('user') },
    expect: 'user',
  },
  {
    name: 'skips a file whose command is empty',
    files: { local: sl(''), user: sl('user') },
    expect: 'user',
  },
  {
    name: 'ignores a command that names conduit-hook.cjs',
    files: { local: sl('conduit-hook.cjs statusline'), user: sl('user') },
    expect: 'user',
  },
  {
    name: 'skips a malformed JSON file',
    files: { local: '{not json', user: sl('user') },
    expect: 'user',
  },
  { name: 'no file has a status line', files: {}, expect: null },
];
