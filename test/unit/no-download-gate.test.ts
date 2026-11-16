import { describe, expect, it } from 'vitest';
import { noDownloadOf } from '../../server/services';

describe('noDownloadOf', () => {
  it('forces the push only under --e2e with CONDUIT_E2E_NO_DOWNLOAD=1', () => {
    expect(noDownloadOf({ e2e: true, env: { CONDUIT_E2E_NO_DOWNLOAD: '1' } })).toBe(true);
  });

  it('never forces the push outside e2e, even when the variable is set', () => {
    expect(noDownloadOf({ e2e: false, env: { CONDUIT_E2E_NO_DOWNLOAD: '1' } })).toBe(false);
  });

  it('needs the exact value 1 under e2e', () => {
    expect(noDownloadOf({ e2e: true, env: {} })).toBe(false);
    expect(noDownloadOf({ e2e: true, env: { CONDUIT_E2E_NO_DOWNLOAD: '0' } })).toBe(false);
  });
});
