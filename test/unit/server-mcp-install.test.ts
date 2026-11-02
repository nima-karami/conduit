import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerInstall } from '../../server/mcp/install';
import { conduitEntry } from '../../src/conduit-mcp/install-entries';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NEW = {
  execPath: '/ud/runtime/shim/node',
  shimPath: '/ud/runtime/shim/conduit-mcp-shim.cjs',
};
const noLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Live files, so startup's repair (which retargets only dead paths) can't be what moved an entry. */
function liveShim(home: string, dir: string) {
  const root = path.join(home, dir);
  fs.mkdirSync(root, { recursive: true });
  const execPath = path.join(root, 'Conduit.exe');
  const shimPath = path.join(root, 'conduit-mcp-shim.cjs');
  fs.writeFileSync(execPath, '');
  fs.writeFileSync(shimPath, '');
  return { execPath, shimPath };
}

type Shim = { execPath: string; shimPath: string };

function setup(entryFor: (home: string) => { entry: unknown; old: Shim }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-install-'));
  dirs.push(home);
  const file = path.join(home, '.claude.json');
  const { entry, old } = entryFor(home);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { conduit: entry } }));
  const install = createServerInstall({
    homeDir: home,
    env: {},
    userDataDir: home,
    platform: 'linux',
    ...NEW,
    onPath: (cli) => cli === 'claude',
    knownHome: () => null,
    log: noLog,
  });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.conduit;
  return { install, read, old, entry };
}

describe('CLI-entry migration (D2b)', () => {
  it('moves an entry this install wrote for a previous shim path to the current one', () => {
    const { install, read, old } = setup((home) => {
      const o = liveShim(home, 'app');
      return { old: o, entry: conduitEntry('claude', o.execPath, o.shimPath) };
    });
    const r = install.startup({ previous: [old], gateMigrated: true });
    expect(read()).toEqual(conduitEntry('claude', NEW.execPath, NEW.shimPath));
    expect(r.rows.some((row) => row.cli === 'claude' && row.errorCode === undefined)).toBe(true);
    expect(install.userState('claude')).toBe('installed');
  });

  it('leaves another Conduit build’s entry alone', () => {
    const { install, read, old, entry } = setup((home) => {
      const other = liveShim(home, 'other');
      return {
        old: liveShim(home, 'app'),
        entry: conduitEntry('claude', other.execPath, other.shimPath),
      };
    });
    install.startup({ previous: [old], gateMigrated: true });
    expect(read()).toEqual(entry);
  });

  it('refuses a malformed install request', () => {
    const { install } = setup((home) => ({ old: liveShim(home, 'app'), entry: undefined }));
    expect(() => install.act({ cli: 'nope', scope: 'user', action: 'install' })).toThrow();
  });
});
