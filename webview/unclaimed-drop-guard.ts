const isFilesDrag = (e: Event): e is DragEvent =>
  !!(e as DragEvent).dataTransfer?.types.includes('Files');

/** Capture-phase dragover: a 'Files' drag gets preventDefault() + dropEffect='none', so only a
 *  handler that sets its own dropEffect claims it. Bubble-phase drop: a 'Files' drop nobody
 *  preventDefault'ed is preventDefault'ed, or Chromium navigates the window to the file.
 *  Capture, because a tree row's onDragOver stopPropagation()s even when it declines. */
export function installUnclaimedDropGuard(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): () => void {
  const onDragOver = (e: Event) => {
    if (!isFilesDrag(e) || !e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  };
  const onDrop = (e: Event) => {
    if (isFilesDrag(e) && !e.defaultPrevented) e.preventDefault();
  };
  target.addEventListener('dragover', onDragOver, true);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragover', onDragOver, true);
    target.removeEventListener('drop', onDrop);
  };
}
