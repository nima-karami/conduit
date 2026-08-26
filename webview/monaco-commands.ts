/**
 * Run one of Monaco's built-in editor commands and get a promise back.
 *
 * The navigation commands (`editor.action.revealDefinition` and friends) are registered with
 * `registerAction2`, i.e. as COMMANDS — not as editor actions. So `editor.getAction(id)`
 * returns null for every one of them and the obvious `getAction(id).run()` silently does
 * nothing. The public `editor.trigger(source, id, payload)` does reach them, but it drops the
 * command service's promise on the floor, which would leave the navigation unbounded and the
 * "Resolving…" indicator with nothing to switch it off.
 *
 * So the command service is reached directly, with `editor.trigger` as the fallback if a
 * future monaco reshuffles these internals: navigation still works, it just loses its
 * deadline rather than breaking outright.
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §3d.
 */

import type * as monaco from 'monaco-editor';
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
import { ICommandService } from 'monaco-editor/esm/vs/platform/commands/common/commands.js';

/**
 * These commands act on the FOCUSED (or active) code editor — `EditorAction2.run` looks it up
 * rather than taking one — so the caller must focus the editor first.
 */
export function executeEditorCommand(
  editor: monaco.editor.ICodeEditor,
  commandId: string,
): Promise<unknown> {
  try {
    const commands = StandaloneServices.get(ICommandService);
    return Promise.resolve(commands.executeCommand(commandId));
  } catch {
    editor.trigger('conduit.nav', commandId, null);
    return Promise.resolve(undefined);
  }
}

/**
 * The same dispatch for a command that takes arguments — `editor.action.goToLocations` /
 * `editor.action.peekLocations`, handed locations we computed ourselves.
 *
 * No `editor.trigger` fallback here: those commands are meaningless without their arguments,
 * and `trigger`'s single payload slot cannot carry five.
 */
export function executeCommandWithArgs(commandId: string, ...args: unknown[]): Promise<unknown> {
  const commands = StandaloneServices.get(ICommandService);
  return Promise.resolve(commands.executeCommand(commandId, ...args));
}
