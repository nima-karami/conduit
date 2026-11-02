import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => runtime.userData, isPackaged: true } }));

import { Logger } from '../../electron/logger';

afterEach(() => {
  if (runtime.userData) fs.rmSync(runtime.userData, { recursive: true, force: true });
  runtime.userData = '';
  vi.unstubAllEnvs();
});

describe('diagnostics server log', () => {
  it('includes a bounded recent server.log tail even with app logging off', () => {
    vi.stubEnv('CONDUIT_E2E', '0');
    const scratch = path.join(os.tmpdir(), 'Codex-scratch');
    fs.mkdirSync(scratch, { recursive: true });
    runtime.userData = fs.mkdtempSync(path.join(scratch, 'diagnostics-'));
    fs.writeFileSync(
      path.join(runtime.userData, 'server.log'),
      `old-server-line\n${Array.from({ length: 250 }, (_, i) => `server-${i}`).join('\n')}\n`,
    );
    const logger = new Logger('off');
    const result = logger.buildDiagnostics({
      appVersion: '1',
      electron: '1',
      chrome: '1',
      node: '1',
      platform: 'linux',
      osRelease: '1',
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error('diagnostics bundle was not written');
    const body = fs.readFileSync(result, 'utf8');
    expect(body).toContain('server.log');
    expect(body).toContain('server-249');
    expect(body).not.toContain('old-server-line');
    expect(body).not.toContain('server-49\n');
  });
});
