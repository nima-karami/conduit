/**
 * Publishes "a code navigation finished" on <html>, so a test (or any observer) can wait on the
 * navigation itself instead of sampling the editor until it stops moving. Same idea as
 * `data-plan-save`. Monaco-free so it is unit-testable in the node env.
 *
 *   data-nav-seq     completed navigations, ever
 *   data-nav-state   `running` while any is in flight, else the last outcome's kind
 *   data-nav-target  `path:line:column` of the file a landing opened, '' when it opened none
 */

export interface NavSignalHost {
  dataset: Record<string, string | undefined>;
}

export interface NavSignal {
  begin(): void;
  /** The file position the navigation is about to open; published when it ends. */
  landing(path: string, line: number, column: number): void;
  end(outcomeKind: string): void;
}

export function createNavSignal(host: NavSignalHost | null): NavSignal {
  let running = 0;
  let seq = 0;
  let target = '';
  const publish = (state: string): void => {
    if (!host) return;
    host.dataset.navSeq = String(seq);
    host.dataset.navState = state;
    host.dataset.navTarget = target;
  };
  return {
    begin() {
      running += 1;
      if (running === 1) target = '';
      publish('running');
    },
    landing(path, line, column) {
      target = `${path}:${line}:${column}`;
    },
    end(outcomeKind) {
      running = Math.max(0, running - 1);
      seq += 1;
      publish(running > 0 ? 'running' : outcomeKind);
    },
  };
}

export const navSignal: NavSignal = createNavSignal(
  typeof document === 'undefined' ? null : document.documentElement,
);
