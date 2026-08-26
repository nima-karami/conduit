/**
 * Show one navigation outcome where the user is already looking.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md contract 3.
 */

import type * as monaco from 'monaco-editor';
import type { NavMessage } from './nav-outcome';
import { pushToast } from './toast-store';

/** Monaco's inline message contribution — the widget its own Go to Definition uses. Reached
 *  by id because the class isn't exported from the public entry. */
const MESSAGE_CONTROLLER_ID = 'editor.contrib.messageController';

interface MessageController extends monaco.editor.IEditorContribution {
  showMessage(message: string, position: monaco.IPosition): void;
}

export function showNavMessage(editor: monaco.editor.ICodeEditor, message: NavMessage): void {
  const position = editor.getPosition();
  if (message.channel === 'inline' && position) {
    const controller = editor.getContribution<MessageController>(MESSAGE_CONTROLLER_ID);
    if (controller && typeof controller.showMessage === 'function') {
      controller.showMessage(message.text, position);
      return;
    }
  }
  pushToast({ message: message.text, variant: message.variant });
}
