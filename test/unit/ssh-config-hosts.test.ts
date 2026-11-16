import { describe, expect, it } from 'vitest';
import { parseSshConfigHosts } from '../../src/network/ssh-config-hosts';

describe('parseSshConfigHosts', () => {
  it('parses Host aliases, skips wildcards and negations', () => {
    expect(parseSshConfigHosts('Host a b\nHost *\nhost=c\nHost !d e?\n')).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates in file order and accepts spaced and mixed-case keywords', () => {
    const text = ['HOST zeta alpha', 'Host = alpha', '  host beta  ', 'HostName 10.0.0.1'].join(
      '\n',
    );
    expect(parseSshConfigHosts(text)).toEqual(['zeta', 'alpha', 'beta']);
  });

  it('ignores comments, other keywords and Include lines', () => {
    const text = ['# Host hidden', 'Include ~/.ssh/other', 'User me', 'Host real'].join('\n');
    expect(parseSshConfigHosts(text)).toEqual(['real']);
  });

  it('stops at an OpenSSH mid-line comment', () => {
    expect(parseSshConfigHosts('Host build # prod')).toEqual(['build']);
  });

  it('skips a quoted name whole, including the rest of it', () => {
    expect(parseSshConfigHosts('Host "a b" c')).toEqual(['c']);
    expect(parseSshConfigHosts('Host "solo" d')).toEqual(['d']);
  });

  it('an empty or missing-host file has no hosts', () => {
    expect(parseSshConfigHosts('')).toEqual([]);
  });
});
