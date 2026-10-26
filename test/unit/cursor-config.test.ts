import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCursorConnect, readCursorLaunchEntry } from '../../electron/cursor-connect';
import {
  cursorConfigState,
  cursorEntry,
  mergeCursorEntry,
  parseCursorConfig,
  removeCursorEntry,
  serializeCursorConfig,
  wiresLaunch,
} from '../../src/conduit-mcp/cursor-config';

const roots: string[] = [];
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-cursor-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Cursor user MCP config', () => {
  const execPath = '/app/conduit';
  const shimPath = '/app/conduit-mcp/index.js';
  const entry = cursorEntry(execPath, shimPath);

  it('connects a missing file and backs up the original null state', () => {
    const dir = home();
    const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
    expect(api.connect().state).toBe('connected');
    const config = path.join(dir, '.cursor', 'mcp.json');
    expect(fs.readFileSync(config, 'utf8')).toBe(
      `${JSON.stringify({ mcpServers: { conduit: entry } }, null, 2)}\n`,
    );
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe('null');
  });

  it('backs up an existing empty config', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, '{}');
    expect(createCursorConnect({ homeDir: dir, execPath, shimPath }).connect().state).toBe(
      'connected',
    );
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe('{}');
  });

  it('does not back up or rewrite an already connected entry', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = JSON.stringify({ mcpServers: { conduit: entry } });
    fs.writeFileSync(config, original);
    const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
    expect(api.connect().state).toBe('connected');
    expect(fs.readFileSync(config, 'utf8')).toBe(original);
    expect(fs.existsSync(`${config}.conduit-backup`)).toBe(false);
  });

  it('preserves other servers, backs up original once, and disconnects only conduit', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = '{"mcpServers":{"other":{"command":"x"}}}\n';
    fs.writeFileSync(config, original);
    const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
    expect(api.connect().state).toBe('connected');
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.other).toEqual({ command: 'x' });
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe(original);
    api.connect();
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe(original);
    expect(api.disconnect().state).toBe('disconnected');
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({
      mcpServers: { other: { command: 'x' } },
    });
  });

  it('reads BOM JSON, distinguishes stale, and wires any entry with both placeholders', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(
      config,
      `\uFEFF${JSON.stringify({ mcpServers: { conduit: { ...entry, command: 'other' } } })}`,
    );
    const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
    expect(api.read().state).toBe('stale');
    expect(wiresLaunch({ env: entry.env })).toBe(true);
    expect(readCursorLaunchEntry(dir)).toBe(true);
  });

  it('pure config functions preserve unrelated values and compare object keys independent of order', () => {
    const parsed = parseCursorConfig(
      '\uFEFF{"other":1,"mcpServers":{"other":{"args":["a"],"command":"x"}}}',
    );
    expect(
      cursorConfigState(
        parseCursorConfig(
          JSON.stringify({
            mcpServers: { conduit: { env: entry.env, args: entry.args, command: entry.command } },
          }),
        ),
        entry,
      ),
    ).toBe('connected');
    const merged = mergeCursorEntry(parsed, entry);
    expect(merged.root.other).toBe(1);
    expect(merged.servers.other).toEqual({ args: ['a'], command: 'x' });
    expect(JSON.parse(serializeCursorConfig(merged.root)).mcpServers.conduit).toEqual(entry);
    expect(removeCursorEntry(merged).servers.other).toEqual({ args: ['a'], command: 'x' });
  });

  it.each(['{', '[]', '{"mcpServers":[]}'])(
    'rejects invalid config %s without changing it',
    (content) => {
      const dir = home();
      const config = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, content);
      const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
      expect(api.read().state).toBe('error');
      expect(api.read().errorCode).toBe('EJSON');
      expect(api.connect().state).toBe('error');
      expect(api.disconnect().state).toBe('error');
      expect(api.disconnect().errorCode).toBe('EJSON');
      expect(fs.readFileSync(config, 'utf8')).toBe(content);
    },
  );

  it('disconnects a stale entry and leaves the backup intact', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(`${config}.conduit-backup`, 'original backup');
    fs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: { conduit: { ...entry, command: 'other' }, keep: { command: 'x' } },
      }),
    );
    const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
    expect(api.read().state).toBe('stale');
    expect(api.disconnect().state).toBe('disconnected');
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({
      mcpServers: { keep: { command: 'x' } },
    });
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe('original backup');
  });

  it('backs up a stale conduit entry before overwriting it', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = JSON.stringify({
      mcpServers: { conduit: { ...entry, command: 'old-install' }, keep: { command: 'x' } },
    });
    fs.writeFileSync(config, original);
    const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
    expect(api.connect().state).toBe('connected');
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.conduit).toEqual(entry);
  });

  it('leaves an existing backup untouched when replacing a stale conduit entry', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(
      config,
      JSON.stringify({ mcpServers: { conduit: { ...entry, command: 'old' } } }),
    );
    fs.writeFileSync(`${config}.conduit-backup`, 'prior backup');
    expect(createCursorConnect({ homeDir: dir, execPath, shimPath }).connect().state).toBe(
      'connected',
    );
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe('prior backup');
  });

  it('reports backup write failure and leaves the original config untouched', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = '{"mcpServers":{"keep":{"command":"x"}}}';
    fs.writeFileSync(config, original);
    const io = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === 'writeFileSync')
          return () => {
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const result = createCursorConnect({ homeDir: dir, execPath, shimPath, io }).connect();
    expect(result).toMatchObject({
      state: 'disconnected',
      actionFailed: true,
      errorCode: 'ENOSPC',
    });
    expect(fs.readFileSync(config, 'utf8')).toBe(original);
    expect(fs.existsSync(`${config}.conduit-backup`)).toBe(false);
    expect(fs.readdirSync(path.dirname(config)).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('keeps the original backup when the config write fails', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = '{"mcpServers":{"keep":{"command":"x"}}}';
    fs.writeFileSync(config, original);
    let writes = 0;
    const io = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === 'writeFileSync') {
          return (...args: Parameters<typeof fs.writeFileSync>) => {
            writes += 1;
            if (writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            return fs.writeFileSync(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = createCursorConnect({ homeDir: dir, execPath, shimPath, io }).connect();
    expect(result).toMatchObject({
      state: 'disconnected',
      actionFailed: true,
      errorCode: 'ENOSPC',
    });
    expect(fs.readFileSync(config, 'utf8')).toBe(original);
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe(original);
  });

  it('does not overwrite a backup created concurrently', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    const backup = `${config}.conduit-backup`;
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = '{"mcpServers":{"keep":{"command":"x"}}}';
    fs.writeFileSync(config, original);
    const io = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === 'linkSync') {
          return () => {
            fs.writeFileSync(backup, 'other backup');
            throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(createCursorConnect({ homeDir: dir, execPath, shimPath, io }).connect().state).toBe(
      'connected',
    );
    expect(fs.readFileSync(backup, 'utf8')).toBe('other backup');
  });

  it('falls back to exclusive copy when hard-linking the backup is denied', () => {
    const dir = home();
    const config = path.join(dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = '{"mcpServers":{"keep":{"command":"x"}}}';
    fs.writeFileSync(config, original);
    const io = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === 'linkSync') {
          return () => {
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(createCursorConnect({ homeDir: dir, execPath, shimPath, io }).connect().state).toBe(
      'connected',
    );
    expect(fs.readFileSync(`${config}.conduit-backup`, 'utf8')).toBe(original);
  });

  it.skipIf(process.platform === 'win32')(
    'does not replace an existing dangling backup symlink',
    () => {
      const dir = home();
      const cursorDir = path.join(dir, '.cursor');
      fs.mkdirSync(cursorDir, { recursive: true });
      const config = path.join(cursorDir, 'mcp.json');
      const backup = `${config}.conduit-backup`;
      fs.writeFileSync(config, '{}');
      const target = path.join(dir, 'missing-backup-target.json');
      fs.symlinkSync(target, backup);
      const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
      expect(api.connect().state).toBe('connected');
      expect(fs.lstatSync(backup).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'writes through a config symlink without replacing it',
    () => {
      const dir = home();
      const cursorDir = path.join(dir, '.cursor');
      fs.mkdirSync(cursorDir, { recursive: true });
      const target = path.join(dir, 'managed-mcp.json');
      fs.writeFileSync(target, '{}');
      const config = path.join(cursorDir, 'mcp.json');
      fs.symlinkSync(target, config);
      createCursorConnect({ homeDir: dir, execPath, shimPath }).connect();
      expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers.conduit).toEqual(entry);
    },
  );

  it.skipIf(process.platform === 'win32')('does not replace a dangling config symlink', () => {
    const dir = home();
    const cursorDir = path.join(dir, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const config = path.join(cursorDir, 'mcp.json');
    const target = path.join(dir, 'missing-target.json');
    fs.symlinkSync(target, config);
    const api = createCursorConnect({ homeDir: dir, execPath, shimPath });
    expect(api.read().state).toBe('error');
    expect(api.connect().state).toBe('error');
    expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves config mode and writes a private backup',
    () => {
      const dir = home();
      const config = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, '{"mcpServers":{"keep":{}}}');
      fs.chmodSync(config, 0o640);
      createCursorConnect({ homeDir: dir, execPath, shimPath }).connect();
      expect(fs.statSync(config).mode & 0o777).toBe(0o640);
      expect(fs.statSync(`${config}.conduit-backup`).mode & 0o777).toBe(0o600);
    },
  );
});
