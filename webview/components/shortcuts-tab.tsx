import { useEffect, useState } from 'react';
import type { AppSettings } from '../../src/settings';
import { editorComboFromEvent, validateEditorCombo } from '../editor-combo';
import {
  type Conflict,
  canonicalCombo,
  findConflicts,
  type MonacoDefaultBinding,
  navOverride,
} from '../nav-keybindings';
import {
  comboFromEvent,
  effectiveCombo,
  formatCombo,
  isMac,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
} from '../shortcuts';
import { useOverlayEntry } from '../use-overlay-entry';

/** Joins the overlay stack as a popover for as long as a shortcut is being recorded, so Escape
 *  cancels the recording without the Settings modal itself seeing it (spec 2026-09-07-overlay-
 *  layers §2.2: the recorder used to beat the modal's own Escape by registering capture-phase). */
function RecorderEscape({ onCancel }: { onCancel: () => void }) {
  useOverlayEntry('popover', onCancel);
  return null;
}

export function ShortcutsTab({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
  const [recording, setRecording] = useState<string | null>(null);
  // Why the last keypress on an editor row was refused; cleared whenever recording ends or moves.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const overrides = settings.shortcuts;
  const [monacoDefaults, setMonacoDefaults] = useState<readonly MonacoDefaultBinding[]>([]);
  // Loaded on demand so the Settings modal's module graph stays free of the Monaco adapter (and
  // monaco itself); in the app bundle it resolves at once.
  useEffect(() => {
    let live = true;
    import('../monaco-nav-keybindings')
      .then((m) => {
        if (live) setMonacoDefaults(m.readMonacoDefaultBindings());
      })
      .catch((err) => console.error('Shortcuts: reading Monaco default keybindings failed', err));
    return () => {
      live = false;
    };
  }, []);

  const startRecording = (a: ShortcutAction) => {
    setRecording(a.id);
    setRefusal(null);
    setAnnouncement(`Recording shortcut for ${a.description}. Press keys, Escape to cancel.`);
  };
  const stopRecording = () => {
    setRecording(null);
    setRefusal(null);
  };

  // While recording, capture the next real combo and save it as an override. Escape cancels via
  // the overlay stack instead (RecorderEscape below): `stopPropagation` doesn't stop a SIBLING
  // listener on the same target (only `stopImmediatePropagation` would), so this listener must
  // still ignore Escape itself or it would record "Escape" as the combo.
  useEffect(() => {
    if (!recording) return;
    const action = SHORTCUT_ACTIONS.find((a) => a.id === recording);
    if (!action) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (action.scope !== 'editor') {
        const combo = comboFromEvent(e);
        if (!combo) return; // modifier-only, keep waiting
        update({ shortcuts: { ...overrides, [recording]: combo } });
        setRecording(null);
        setAnnouncement(`${action.description} set to ${formatCombo(combo)}`);
        return;
      }
      const combo = editorComboFromEvent(e, isMac);
      if (!combo) return;
      const reason = validateEditorCombo(combo);
      if (reason) {
        setRefusal(reason);
        setAnnouncement(reason);
        return;
      }
      const next = { ...overrides };
      // Recording the default is a reset, so Reset never shows for a no-op override.
      if (canonicalCombo(combo) === canonicalCombo(action.defaultCombo)) delete next[action.id];
      else next[action.id] = combo;
      update({ shortcuts: next });
      setRecording(null);
      setRefusal(null);
      setAnnouncement(`${action.description} set to ${formatCombo(combo)}`);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, overrides, update]);

  const comboFor = (id: string) => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
    if (!action) throw new Error(`Unknown shortcut action: ${id}`);
    return effectiveCombo(action, overrides);
  };
  const conflictNote = (c: Conflict): string => {
    if (c.kind !== 'app') return `· shadows ${c.label} in the editor`;
    return c.editorScoped
      ? `· conflict: ${c.label}`
      : `· conflict: overrides ${c.label} while editing`;
  };
  const overridden = (a: ShortcutAction) =>
    a.scope === 'editor' ? navOverride(a, overrides) !== undefined : !!overrides[a.id];
  const reset = (a: ShortcutAction) => {
    const next = { ...overrides };
    delete next[a.id];
    update({ shortcuts: next });
    setAnnouncement(`${a.description} reset to ${formatCombo(a.defaultCombo)}`);
  };

  const groups = [...new Set(SHORTCUT_ACTIONS.map((s) => s.group))];
  return (
    <div className="shortcuts">
      {recording && <RecorderEscape onCancel={stopRecording} />}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      {groups.map((g) => (
        <div className="shortcuts__group" key={g}>
          <div className="shortcuts__gtitle">{g}</div>
          {SHORTCUT_ACTIONS.filter((s) => s.group === g).map((s) => {
            const conflicts = findConflicts(s.id, overrides, monacoDefaults);
            return (
              <div className="shortcuts__row" key={s.id}>
                <span className="shortcuts__desc">
                  {s.description}
                  {s.scope !== 'editor' && conflicts.length > 0 && (
                    <span className="shortcuts__conflict"> · conflict</span>
                  )}
                  {s.scope === 'editor' &&
                    recording !== s.id &&
                    validateEditorCombo(comboFor(s.id)) !== null && (
                      <span className="shortcuts__conflict"> · can't be bound in the editor</span>
                    )}
                  {s.scope === 'editor' &&
                    conflicts.map((c) => (
                      <span
                        className="shortcuts__note shortcuts__note--conflict"
                        key={
                          c.kind === 'monaco' ? c.command : c.kind === 'app' ? c.actionId : c.label
                        }
                      >
                        {conflictNote(c)}
                      </span>
                    ))}
                  {recording === s.id && refusal && (
                    <span className="shortcuts__note shortcuts__note--refusal">{refusal}</span>
                  )}
                </span>
                <span className="shortcuts__keys">
                  {recording === s.id ? (
                    <kbd className="shortcuts__recording">Press keys…</kbd>
                  ) : (
                    <kbd>{formatCombo(comboFor(s.id))}</kbd>
                  )}
                  <button
                    className="shortcuts__btn"
                    aria-label={`Record shortcut for ${s.description}`}
                    onClick={() => startRecording(s)}
                  >
                    Record
                  </button>
                  {overridden(s) && (
                    <button
                      className="shortcuts__btn"
                      aria-label={`Reset ${s.description} to ${formatCombo(s.defaultCombo)}`}
                      onClick={() => reset(s)}
                    >
                      Reset
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
