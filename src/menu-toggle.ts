/**
 * Determines whether a button-anchored menu should open or close when its
 * trigger is clicked, given that the ContextMenu dismiss listener (mousedown
 * capture phase) may have already closed the menu before the click fires.
 *
 * Problem: ContextMenu closes on mousedown (capture); the trigger's click fires
 * after. Without coordination the menu always re-opens on a second click instead
 * of toggling closed.
 *
 * Solution: the trigger records whether the menu was open at mousedown time
 * (via `wasOpenAtMousedown`). If it was open, the menu was just dismissed by the
 * mousedown, so the click should be a no-op (stay closed). If it was not open,
 * the click should open it.
 *
 * Pure and DOM-free so it can be unit-tested without jsdom.
 */
export function menuToggleIntent(wasOpenAtMousedown: boolean): 'open' | 'close' {
  // If the menu was open when the user pressed down on the trigger, the
  // ContextMenu's dismiss listener already closed it by the time click fires.
  // The click is therefore "close" (do nothing — already closed).
  // If it was not open, the click should open the menu.
  return wasOpenAtMousedown ? 'close' : 'open';
}
