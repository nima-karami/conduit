import { describe, expect, it } from 'vitest';
import { parseSshConfigHosts } from '../../src/network/ssh-config-hosts';

describe('parseSshConfigHosts', () => {
  it('parses Host aliases, skips wildcards and negations', () => {
    expect(parseSshConfigHosts('Host a b\nHost *\nhost=c\nHost !d e?\n')).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates in file order and accepts spaced and mixed-case keywords', () => {
    const text = ['HOST zeta alpha', 'Host = alpha', '  host beta  ', 'HostName 10.0.0.1'].join('\n');
    expect(parseSshConfigHosts(text)).toEqual(['zeta', 'alpha', 'beta']);
  });

  it('ignores comments, other keywords and Include lines', () => {
    const text = ['# Host hidden', 'Include ~/.ssh/other', 'User me', 'Host real'].join('\n');
    expect(parseSshConfigHosts(text)).toEqual(['real']);
  });

  it('an empty or missing-host file has no hosts', () => {
    expect(parseSshConfigHosts('')).toEqual([]);
  });
});
