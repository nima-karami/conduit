/**
 * Imperative right-panel work (search, reveal, messages) queued until the pane's handle is
 * mounted, so it never races a mount in the same commit. A collapse drops the queue: work asked
 * of a panel the user then closed must not replay on the next open.
 */
export function createPaneQueue<H>() {
  const actions: ((pane: H) => void)[] = [];
  return {
    push(action: (pane: H) => void): void {
      actions.push(action);
    },
    drain(pane: H | null, open: boolean): void {
      if (!open) {
        actions.length = 0;
        return;
      }
      if (!pane) return;
      for (const action of actions.splice(0)) action(pane);
    },
  };
}
