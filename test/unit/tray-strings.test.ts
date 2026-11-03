import { describe, expect, it } from 'vitest';
import { agentsRunning, confirmBody, plural, serviceExhausted } from '../../src/tray-strings';

describe('tray strings', () => {
  it('plural picks one only for exactly 1', () => {
    expect(plural(1, 'a', 'b')).toBe('a');
    expect(plural(0, 'a', 'b')).toBe('b');
    expect(plural(2, 'a', 'b')).toBe('b');
  });
  it('agentsRunning singular/plural', () => {
    expect(agentsRunning(1)).toBe('1 agent running');
    expect(agentsRunning(3)).toBe('3 agents running');
  });
  it('confirmBody agrees in number and keeps the clause optional', () => {
    expect(confirmBody(1, null)).toContain('1 agent is running');
    expect(confirmBody(3, '1 needs you')).toContain(
      "3 agents are running in Conduit's background service (1 needs you).",
    );
    expect(confirmBody(3, null)).not.toContain('(');
  });
  it('exhausted line carries the time', () => {
    expect(serviceExhausted('14:05')).toContain('Retrying at 14:05.');
  });
});
