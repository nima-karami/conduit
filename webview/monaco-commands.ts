/**
 * Run one of Monaco's built-in editor commands and get a promise back.
 *
 * The navigation commands (`editor.action.goToLocations`, `editor.action.peekLocations`,
 * `editor.action.revealDefinition` and friends) live in the `CommandsRegistry`, not as editor
 * actions. So `editor.getAction(id)` returns null for every one of them and the obvious
 * `getAction(id).run()` silently does nothing. `editor.trigger(source, id, payload)` does
 * reach them, but it drops the command service's promise on the floor — and its single
 * payload slot cannot carry the five arguments the location commands take. Hence the command
 * service, directly.
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §3d and
 * docs/specs/2026-08-21-goto-definition-flows.md contract 3.
 */

import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
import { ICommandService } from 'monaco-editor/esm/vs/platform/commands/common/commands.js';

/**
 * `editor.action.goToLocations` / `editor.action.peekLocations` take the locations to show, so
 * they act on the editor named by their first argument rather than on the focused one.
 */
export function executeCommandWithArgs(commandId: string, ...args: unknown[]): Promise<unknown> {
  const commands = StandaloneServices.get(ICommandService);
  return Promise.resolve(commands.executeCommand(commandId, ...args));
}
