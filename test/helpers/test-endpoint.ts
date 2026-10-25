// A fresh local endpoint per call for socket-based tests: a named pipe on Windows dev machines, a
// tmp unix socket on CI (ubuntu). Tests use it without asserting either platform's behaviour.

import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export function testEndpoint(): string {
  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\conduit-mcp-test-${tag}`
    : path.join(os.tmpdir(), `cmcp-${tag}.sock`);
}
