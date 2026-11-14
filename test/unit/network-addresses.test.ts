import { describe, expect, it } from 'vitest';
import { displayNames, formatAddress, parseAddress } from '../../src/network/addresses';

describe('parseAddress', () => {
  it('reads a bare handle with no machine', () => {
    expect(parseAddress('claude-1')).toEqual({ handle: 'claude-1', machine: null });
  });

  it('reads a handle with a canonical machine id', () => {
    expect(parseAddress('x@m-0123abcd')).toEqual({ handle: 'x', machine: 'm-0123abcd' });
  });

  it('reads a handle with a machine name', () => {
    expect(parseAddress('x@win-box')).toEqual({ handle: 'x', machine: 'win-box' });
  });

  it("accepts 'you' as the handle", () => {
    expect(parseAddress('you')).toEqual({ handle: 'you', machine: null });
    expect(parseAddress('you@m-0123abcd')).toEqual({ handle: 'you', machine: 'm-0123abcd' });
  });

  it('rejects an empty string', () => {
    expect(parseAddress('')).toBeNull();
  });

  it('rejects more than one @', () => {
    expect(parseAddress('a@b@c')).toBeNull();
    expect(parseAddress('a@@b')).toBeNull();
  });

  it('rejects an empty handle or an empty machine', () => {
    expect(parseAddress('@m-0123abcd')).toBeNull();
    expect(parseAddress('x@')).toBeNull();
  });

  it('rejects any whitespace', () => {
    expect(parseAddress('x y')).toBeNull();
    expect(parseAddress(' x')).toBeNull();
    expect(parseAddress('x@win box')).toBeNull();
    expect(parseAddress('x\t')).toBeNull();
    expect(parseAddress('x@win\nbox')).toBeNull();
  });

  it('rejects a handle outside [a-z0-9-]', () => {
    expect(parseAddress('Claude')).toBeNull();
    expect(parseAddress('a_b')).toBeNull();
    expect(parseAddress('a.b')).toBeNull();
  });

  it('accepts any non-empty machine text without @ or whitespace', () => {
    expect(parseAddress('x@Ünïcode-🖥')).toEqual({ handle: 'x', machine: 'Ünïcode-🖥' });
  });

  it('rejects a string longer than 200 characters', () => {
    expect(parseAddress(`x@${'m'.repeat(198)}`)).not.toBeNull();
    expect(parseAddress(`x@${'m'.repeat(199)}`)).toBeNull();
  });
});

describe('formatAddress', () => {
  it('joins handle and machine id with @', () => {
    expect(formatAddress('claude-1', 'm-0123abcd')).toBe('claude-1@m-0123abcd');
  });

  it('round-trips through parseAddress', () => {
    expect(parseAddress(formatAddress('x', 'm-0123abcd'))).toEqual({
      handle: 'x',
      machine: 'm-0123abcd',
    });
  });
});

describe('displayNames', () => {
  it('shows a peer by its name when nothing clashes', () => {
    const names = displayNames(
      [
        { machineId: 'm-00000001', name: 'laptop' },
        { machineId: 'm-00000002', name: 'desk' },
      ],
      'mac',
    );
    expect(names.get('m-00000001')).toBe('laptop');
    expect(names.get('m-00000002')).toBe('desk');
  });

  it('suffixes both peers when two peers share a name, case and space-insensitively', () => {
    const names = displayNames(
      [
        { machineId: 'm-00000001', name: 'laptop' },
        { machineId: 'm-00000002', name: '  Laptop ' },
        { machineId: 'm-00000003', name: 'desk' },
      ],
      'mac',
    );
    expect(names.get('m-00000001')).toBe('laptop (m-00000001)');
    expect(names.get('m-00000002')).toBe('Laptop (m-00000002)');
    expect(names.get('m-00000003')).toBe('desk');
  });

  it('suffixes a peer whose name clashes with self, case and space-insensitively', () => {
    const names = displayNames([{ machineId: 'm-00000001', name: ' MAC ' }], 'mac');
    expect(names.get('m-00000001')).toBe('MAC (m-00000001)');
  });

  it('gives every peer an entry, including an empty peer list', () => {
    expect(displayNames([], 'mac').size).toBe(0);
    expect(displayNames([{ machineId: 'm-00000001', name: 'a' }], 'mac').size).toBe(1);
  });
});
