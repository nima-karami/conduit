import { stopAgentsFailureCopy } from '../src/quit-guard';
import type { ConfirmState } from './components/confirm-dialog';

export function quitStopFailureDialog(
  reason: string,
  answer: (choice: 'retry' | 'leave' | 'cancel') => void,
): ConfirmState {
  const copy = stopAgentsFailureCopy(reason);
  return {
    title: copy.message,
    message: 'Retry stopping the agents, quit and leave them running, or cancel quitting.',
    confirmLabel: copy.buttons[0],
    secondaryLabel: copy.buttons[1],
    focusCancel: true,
    onConfirm: () => answer('retry'),
    onSecondary: () => answer('leave'),
    onCancel: () => answer('cancel'),
  };
}
