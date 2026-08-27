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
  if (message.channel === 'inline') {
    try {
      const position = editor.getPosition();
      const controller = editor.getContribution<MessageController>(MESSAGE_CONTROLLER_ID);
      if (position && controller && typeof controller.showMessage === 'function') {
        controller.showMessage(message.text, position);
        return;
      }
    } catch {
      // An editor disposed mid-navigation (its tab closed under it) has no widget left to host
      // the note. Fall through to the toast rather than lose the outcome — the point of this
      // module is that a navigation is never silent.
    }
  }
  pushToast({ message: message.text, variant: message.variant });
}
