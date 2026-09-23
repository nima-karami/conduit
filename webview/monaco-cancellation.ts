/**
 * Monaco's own cancellation error, as its `isCancellationError` recognises it (base/common/errors):
 * an Error whose name AND message are both 'Canceled'. Disposing an editor cancels its pending
 * work (WordHighlighter's Delayer) and rejects promises nothing awaits; VS Code's host drops those
 * via onUnexpectedError, and the renderer's unhandledrejection handler does the same with this.
 */
export function isMonacoCancellation(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'Canceled' && reason.message === 'Canceled';
}
