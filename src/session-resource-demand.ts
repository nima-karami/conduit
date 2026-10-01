export function createSessionResourceDemand(
  run: (ids: string[]) => void,
  onHidden: (ids: string[]) => void = () => {},
) {
  const windows = new Map<number, Set<string>>();
  const suspended = new Set<number>();
  const dirty = new Set<string>();
  let reported = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = (id: string) =>
    !reported || [...windows].some(([windowId, ids]) => !suspended.has(windowId) && ids.has(id));
  const visibleIds = () =>
    new Set([...windows.values()].flatMap((ids) => [...ids]).filter(visible));
  const hidden = (before: Set<string>) => onHidden([...before].filter((id) => !visible(id)));
  const arm = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const ids = [...dirty].filter(visible);
      for (const id of ids) dirty.delete(id);
      if (ids.length) run(ids);
    }, 150);
  };
  const wake = (ids: Iterable<string>) => {
    for (const id of ids) dirty.add(id);
    arm();
  };
  return {
    isVisible: visible,
    isVisibleInWindow(windowId: number, id: string) {
      return !reported || (!suspended.has(windowId) && windows.get(windowId)?.has(id) === true);
    },
    schedule(id: string) {
      dirty.add(id);
      if (visible(id)) arm();
    },
    setVisible(windowId: number, ids: readonly string[]) {
      const before = visibleIds();
      const newlyVisible = ids.filter((id) => !visible(id) || !reported);
      reported = true;
      windows.set(windowId, new Set(ids));
      hidden(before);
      wake(newlyVisible);
    },
    setSuspended(windowId: number, value: boolean) {
      const before = visibleIds();
      if (value) suspended.add(windowId);
      else {
        suspended.delete(windowId);
        wake(windows.get(windowId) ?? []);
      }
      hidden(before);
    },
    dropWindow(windowId: number) {
      const before = visibleIds();
      windows.delete(windowId);
      suspended.delete(windowId);
      hidden(before);
    },
    clearPending(id: string) {
      dirty.delete(id);
    },
    forget(id: string) {
      dirty.delete(id);
      for (const ids of windows.values()) ids.delete(id);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      dirty.clear();
      windows.clear();
      suspended.clear();
    },
  };
}
