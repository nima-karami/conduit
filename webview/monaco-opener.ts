/**
 * Teach Monaco how to open a file that isn't the one on screen.
 *
 * This is the single reason built-in navigation never worked here. Monaco's standalone
 * `ICodeEditorService.findModel` returns null for any URI other than the current editor's
 * model, so `doOpenEditor` returns null and Go to Definition / Type Definition /
 * Implementations / References silently do nothing across files — which had been recorded in
 * CLAUDE.md as an esbuild bundling problem. It isn't; `registerEditorOpener` is the public
 * extension point for exactly this, and with it every built-in navigation command works
 * cross-file, with its own keybindings, peek widgets and multi-result pickers.
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §3a.
 */

import * as monaco from 'monaco-editor';
import { openDefinitionFile, setReveal } from './project-index';

/** Monotonic counter of opens this module has handled — how callers tell a navigation
 *  happened without inspecting Monaco's internals. */
let openCount = 0;

export function openedCount(): number {
  return openCount;
}

function toLineColumn(target: monaco.IRange | monaco.IPosition | undefined): {
  line: number;
  column: number;
} {
  if (!target) return { line: 1, column: 1 };
  if ('startLineNumber' in target)
    return { line: target.startLineNumber, column: target.startColumn };
  return { line: target.lineNumber, column: target.column };
}

/**
 * Register the opener. Global to Monaco (not per editor), so this is called once at boot.
 * Returning false — for a non-file scheme, or a target already on screen — falls through to
 * Monaco's own handler rather than swallowing the request.
 */
export function registerConduitEditorOpener(): monaco.IDisposable {
  return monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false;
      if (source.getModel()?.uri.toString() === resource.toString()) return false;
      const abs = resource.path.replace(/^\/+/, '');
      setReveal(abs, toLineColumn(selectionOrPosition));
      openDefinitionFile(abs);
      openCount += 1;
      return true;
    },
  });
}
