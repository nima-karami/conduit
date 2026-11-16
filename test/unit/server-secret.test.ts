import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeServerSecret } from '../../server/lifecycle/server-secret';
import { readServerSecret, SERVER_SECRET_FILE } from '../../src/server-secret';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function userData(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'secret-test-'));
  directories.push(dir);
  return dir;
}

describe('server secret file', () => {
  it.skipIf(process.platform === 'win32')(
    'writeServerSecret writes 0600 and a new value each start',
    async () => {
      const dir = await userData();
      const first = writeServerSecret(dir);
      const file = path.join(dir, SERVER_SECRET_FILE);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(readServerSecret(dir)).toBe(first);
      const second = writeServerSecret(dir);
      expect(second).not.toBe(first);
      expect(readServerSecret(dir)).toBe(second);
    },
  );

  it('the secret is 32 random bytes as base64url', async () => {
    const secret = writeServerSecret(await userData());
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('readServerSecret is null when no file exists', async () => {
    expect(readServerSecret(await userData())).toBeNull();
  });
});
