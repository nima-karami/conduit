import { describe, expect, it } from 'vitest';
import type { Listener } from '../../server/network/listener';
import { createPairingPort } from '../../server/network/pairing-port';

function fakeListen() {
  const made: Array<{ address: string; closed: boolean; resolve: () => void }> = [];
  const listen = () =>
    new Promise<Listener>((resolve) => {
      const entry = {
        address: `127.0.0.1:${40000 + made.length}`,
        closed: false,
        resolve: () => {},
      };
      const l: Listener = {
        addresses: () => [entry.address],
        close: async () => {
          entry.closed = true;
        },
      };
      entry.resolve = () => resolve(l);
      made.push(entry);
    });
  return { made, listen };
}

describe('pairing port', () => {
  it('an open overtaken by another closes its own listener and leaves the newest open', async () => {
    const f = fakeListen();
    const port = createPairingPort(f.listen);
    const first = port.open();
    const second = port.open();
    f.made[0]?.resolve();
    await expect(first).rejects.toThrow('superseded');
    f.made[1]?.resolve();
    await expect(second).resolves.toEqual([f.made[1]?.address]);
    expect(f.made.map((m) => m.closed)).toEqual([true, false]);
  });

  it('an open that lands after the newest one still closes itself', async () => {
    const f = fakeListen();
    const port = createPairingPort(f.listen);
    const first = port.open();
    const second = port.open();
    f.made[1]?.resolve();
    await second;
    f.made[0]?.resolve();
    await expect(first).rejects.toThrow('superseded');
    expect(f.made.map((m) => m.closed)).toEqual([true, false]);
  });

  it('a close while an open is pending closes that listener when it arrives', async () => {
    const f = fakeListen();
    const port = createPairingPort(f.listen);
    const pending = port.open();
    port.close();
    f.made[0]?.resolve();
    await expect(pending).rejects.toThrow('superseded');
    expect(f.made[0]?.closed).toBe(true);
  });

  it('close shuts the open listener', async () => {
    const f = fakeListen();
    const port = createPairingPort(f.listen);
    const p = port.open();
    f.made[0]?.resolve();
    await p;
    port.close();
    expect(f.made[0]?.closed).toBe(true);
  });
});
