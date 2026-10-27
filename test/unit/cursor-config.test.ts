import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCursorLaunchEntry } from '../../electron/mcp-install';
import { cursorEntry, wiresLaunch } from '../../src/conduit-mcp/cursor-config';

const roots: string[] = [];
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-cursor-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function seed(dir: string, text: string): string {
  const config = path.join(dir, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, text);
  return config;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Cursor placeholder, not a template
const TOKEN = '${env:CONDUIT_SESSION_TOKEN}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Cursor placeholder, not a template
const ENDPOINT = '${env:CONDUIT_MCP_ENDPOINT}';

describe('Cursor launch wiring', () => {
  const entry = cursorEntry('/app/conduit', '/app/conduit-mcp/index.js');

  it('the entry forwards identity through Cursor placeholders', () => {
    expect(entry).toEqual({
      command: '/app/conduit',
      args: ['/app/conduit-mcp/index.js'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CONDUIT_SESSION_TOKEN: TOKEN,
        CONDUIT_MCP_ENDPOINT: ENDPOINT,
      },
    });
  });

  it('wiresLaunch needs both placeholders, whatever the command', () => {
    expect(wiresLaunch({ env: entry.env })).toBe(true);
    expect(wiresLaunch({ ...entry, command: 'other' })).toBe(true);
    expect(wiresLaunch({ env: { CONDUIT_SESSION_TOKEN: TOKEN } })).toBe(false);
    expect(wiresLaunch(undefined)).toBe(false);
    expect(wiresLaunch({ env: 'x' })).toBe(false);
  });

  it('reads a BOM file and wires any entry carrying both placeholders', () => {
    const dir = home();
    seed(
      dir,
      `\uFEFF${JSON.stringify({ mcpServers: { conduit: { ...entry, command: 'other' } } })}`,
    );
    expect(readCursorLaunchEntry(dir)).toBe(true);
  });

  it.each([
    ['missing', null],
    ['invalid JSON', '{'],
    ['an array', '[]'],
    ['no conduit entry', '{"mcpServers":{"other":{"command":"x"}}}'],
    ['a non-object mcpServers', '{"mcpServers":[]}'],
  ])('%s → not wired', (_name, text) => {
    const dir = home();
    if (text !== null) seed(dir, text);
    expect(readCursorLaunchEntry(dir)).toBe(false);
  });
});
