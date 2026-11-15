import type { Listener } from './listener';

// The one pairing listener a server may have open (plan decision 5: open only during a window).
// Opens can overlap (a start overtaken by another start or a join), so each open carries a
// generation: one overtaken, or closed while still pending, closes its own listener on arrival
// instead of replacing, and leaking, the live one. CON-27 review minor 5.

export interface PairingPort {
  /** Opens the port, closing any open one first; rejects 'superseded' if overtaken meanwhile. */
  open(): Promise<string[]>;
  close(): void;
}

export function createPairingPort(listen: () => Promise<Listener>): PairingPort {
  let current: Listener | null = null;
  let generation = 0;
  const close = (): void => {
    generation += 1;
    const l = current;
    current = null;
    void l?.close();
  };
  return {
    async open() {
      close();
      const mine = generation;
      const opened = await listen();
      if (mine !== generation) {
        void opened.close();
        throw new Error('superseded');
      }
      current = opened;
      return opened.addresses();
    },
    close,
  };
}
