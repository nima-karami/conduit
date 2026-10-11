// How many GPU context losses a renderer rides out before it stops trying: a driver or GPU process
// in a crash loop must not keep rebuilding WebGL. Shared by the terminals and the shader background.

export const GPU_LOSS_WINDOW_MS = 60_000;
export const GPU_GIVE_UP_LOSSES = 3;

/** Records a loss at `now`; `exhausted` once more than GPU_GIVE_UP_LOSSES fall inside the window. */
export function noteGpuLoss(
  losses: readonly number[],
  now: number,
): { losses: number[]; exhausted: boolean } {
  const recent = [...losses.filter((t) => now - t < GPU_LOSS_WINDOW_MS), now];
  return { losses: recent, exhausted: recent.length > GPU_GIVE_UP_LOSSES };
}
