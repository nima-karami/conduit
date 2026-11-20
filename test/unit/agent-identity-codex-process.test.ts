import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCodexServer } from '../../src/agent-identity/codex-process';
import type { AgentIdentityLaunch } from '../../src/contracts/agent-identity';

const APP_SERVER = `
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const listener = process.argv[process.argv.indexOf('--listen') + 1];
const server = createServer((socket) => socket.end());
writeFileSync(process.env.FIXTURE_OUTPUT, JSON.stringify({
  pid: process.pid,
  electron: process.env.ELECTRON_RUN_AS_NODE,
  listener,
  tokenDigest: process.argv[process.argv.indexOf('--ws-token-sha256') + 1],
}));
if (listener.startsWith('unix://')) {
  server.listen(listener.slice('unix://'.length));
} else {
  server.listen(0, '127.0.0.1', () => {
    console.error('listening on: ws://127.0.0.1:' + server.address().port);
  });
}
`;

describe('Codex PTY owner', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps Codex alive after the observer detaches and cleans up on TUI exit',
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'conduit-codex-test-'));
      const output = join(base, 'child.json');
      const release = join(base, 'release-fixture');
      const abort = new AbortController();
      const launch: AgentIdentityLaunch = {
        sessionId: 'session',
        ids: { generation: 1, launchId: 'a'.repeat(32) },
        command: join(base, 'fixture-codex'),
        argv: [],
        scope: { cwd: base, storageHome: base, machineId: 'local' },
        env: { ...process.env, FIXTURE_OUTPUT: output, FIXTURE_RELEASE: release },
        signal: abort.signal,
      };
      try {
        await writeFile(
          launch.command,
          `#!/usr/bin/env node
if (process.argv[2] === 'app-server') {
${APP_SERVER}
} else {
  const { existsSync } = require('node:fs');
  const handle = setInterval(() => {
    if (existsSync(process.env.FIXTURE_RELEASE)) clearInterval(handle);
  }, 20);
}
`,
          { mode: 0o700 },
        );
        const observer = await startCodexServer(launch, [], ['foreground'], join(base, 'run'));
        expect(observer.env?.ELECTRON_RUN_AS_NODE).toBe('1');
        await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
        if (!observer.command) throw new Error('Missing PTY wrapper executable');
        const pty = spawn(observer.command, [...observer.tuiArgs], {
          cwd: base,
          env: { ...launch.env, ...observer.env },
          stdio: 'ignore',
        });
        const closed = once(pty, 'close');
        try {
          const manifest = join(base, 'run', `${launch.ids.launchId}.json`);
          await vi.waitFor(async () => expect((await stat(manifest)).isFile()).toBe(true));
          const child: { pid: number; electron?: string; listener: string; tokenDigest: string } =
            JSON.parse(await readFile(output, 'utf8'));
          expect(child.electron).toBeUndefined();
          const socketDir = child.listener.startsWith('unix://')
            ? dirname(child.listener.slice('unix://'.length))
            : undefined;
          if (socketDir) {
            expect((await stat(socketDir)).mode & 0o777).toBe(0o700);
            expect((await stat(manifest)).mode & 0o777).toBe(0o600);
          } else {
            const { auth } = JSON.parse(await readFile(manifest, 'utf8'));
            expect(auth).toMatch(/^[a-f0-9]{64}$/);
            expect(child.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
            expect(child.tokenDigest).not.toBe(auth);
          }
          await observer.release?.();
          abort.abort();
          expect(() => process.kill(child.pid, 0)).not.toThrow();
          await writeFile(release, '');
          await expect(closed).resolves.toEqual([0, null]);
          expect(() => process.kill(child.pid, 0)).toThrow(/ESRCH/);
          await expect(stat(manifest)).rejects.toMatchObject({ code: 'ENOENT' });
          if (socketDir) await expect(stat(socketDir)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          if (pty.exitCode === null && pty.signalCode === null) {
            await writeFile(release, '');
            pty.kill();
            await closed;
          }
        }
      } finally {
        abort.abort();
        await rm(base, { recursive: true, force: true });
      }
    },
  );
});
