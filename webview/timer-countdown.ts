import { HOUR_MS } from '../src/timed-messages';

export function startTimerCountdown(
  nextAt: number,
  visible: boolean,
  tick: () => void,
): () => void {
  if (!visible) return () => {};
  let handle: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (document.visibilityState === 'hidden') return;
    handle = setTimeout(
      () => {
        tick();
        arm();
      },
      nextAt - Date.now() < HOUR_MS ? 1000 : 60_000,
    );
  };
  const onVisibility = () => {
    if (handle !== null) clearTimeout(handle);
    tick();
    arm();
  };
  arm();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    if (handle !== null) clearTimeout(handle);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
