import { describe, expect, it } from 'vitest';
import { instanceNames } from '../../src/instance-names';

describe('instanceNames', () => {
  it('uses a case-folded Windows identity for both named pipes and hc names', () => {
    const names = instanceNames('ABC', 'win32', 'TEMP');

    expect(names).toEqual({
      instance: 'ba7816bf8f01cfea',
      serverEndpoint: '\\\\.\\pipe\\conduit-server-ba7816bf8f01cfea',
      mcpEndpoint: '\\\\.\\pipe\\conduit-mcp-ba7816bf8f01cfea',
      supervisorName: 'conduit-server-ba7816bf8f01cfea',
      hcSession: 'conduit-ba7816bf8f01cfea',
      runtimeRoot: 'ABC\\runtime',
      hcConfigHome: 'ABC\\hc\\config',
      hcStateHome: 'ABC\\hc\\state',
    });
  });

  it('keeps the POSIX userData identity case-sensitive and uses profile sockets', () => {
    const names = instanceNames('abc', 'posix', '/tmp');
    expect(instanceNames('ABC', 'posix', '/tmp').instance).not.toBe(names.instance);

    expect(names).toEqual({
      instance: 'ba7816bf8f01cfea',
      serverEndpoint: 'abc/conduit-server.sock',
      mcpEndpoint: 'abc/conduit-mcp/mcp.sock',
      supervisorName: 'conduit-server-ba7816bf8f01cfea',
      hcSession: 'conduit-ba7816bf8f01cfea',
      runtimeRoot: 'abc/runtime',
      hcConfigHome: 'abc/hc/config',
      hcStateHome: 'abc/hc/state',
    });
  });

  it('moves an overlong UTF-8 POSIX server socket into tmpdir', () => {
    const userData = '\u00e9'.repeat(45);
    const names = instanceNames(userData, 'posix', '/tmp');

    expect(names.serverEndpoint).toBe(`/tmp/conduit-server-${names.instance}.sock`);
  });
});
