let host: HTMLElement | null = null;

/**
 * A single body-level node for every editor's hover / suggest / parameter-hint widgets
 * (`overflowWidgetsDomNode`, paired with `fixedOverflowWidgets: true` on the create options —
 * spec 2026-09-07-overlay-layers.md §2.1 finding 8). `.termwrap` clips at `overflow: hidden`
 * (`styles.css:3404-3421`), and Monaco's default (non-overflow) widgets are laid out relative to
 * the editor's own box, so a widget near the pane's bottom/right edge is cut off — confirmed by
 * the T3.3 baseline probe (`.autoloop/evidence/2026-09-07-overlay-layers/baseline-monaco-hover.md`).
 *
 * `monaco-editor` is mandatory on the host: Monaco emits its theme as CSS custom properties
 * scoped to `.monaco-editor` (re-emitted on every theme change, so no theme class is copied here),
 * and `webview/typing-guard.ts`'s `isEditorEntry` keys shortcut routing on that class.
 *
 * Lazy on purpose: `code-viewer.tsx`/`diff-viewer.tsx` are in the eager bundle, so creating this
 * at module scope would exist before any editor is ever opened (same reasoning as `pdf-setup.ts`
 * — see CLAUDE.md).
 */
export function monacoOverflowHost(): HTMLElement {
  if (host) return host;
  const el = document.createElement('div');
  el.className = 'monaco-editor monaco-overflow-host';
  document.body.appendChild(el);
  host = el;
  return host;
}
