import { useEffect, useState } from 'react';
import type { AppSettings } from '../../src/settings';
import { comboFromEvent, effectiveCombo, formatCombo, SHORTCUT_ACTIONS } from '../shortcuts';
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
  const overrides = settings.shortcuts;

  // While recording, capture the next real combo and save it as an override. Escape cancels via
  // the overlay stack instead (RecorderEscape below): `stopPropagation` doesn't stop a SIBLING
  // listener on the same target (only `stopImmediatePropagation` would), so this listener must
  // still ignore Escape itself or it would record "Escape" as the combo.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const combo = comboFromEvent(e);
      if (!combo) return; // modifier-only, keep waiting
      update({ shortcuts: { ...overrides, [recording]: combo } });
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, overrides, update]);

  const comboFor = (id: string) => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
    if (!action) throw new Error(`Unknown shortcut action: ${id}`);
    return effectiveCombo(action, overrides);
  };
  const conflict = (id: string) => {
    const c = comboFor(id);
    return SHORTCUT_ACTIONS.some((a) => a.id !== id && comboFor(a.id) === c);
  };
  const reset = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    update({ shortcuts: next });
  };

  const groups = [...new Set(SHORTCUT_ACTIONS.map((s) => s.group))];
  return (
    <div className="shortcuts">
      {recording && <RecorderEscape onCancel={() => setRecording(null)} />}
      {groups.map((g) => (
        <div className="shortcuts__group" key={g}>
          <div className="shortcuts__gtitle">{g}</div>
          {SHORTCUT_ACTIONS.filter((s) => s.group === g).map((s) => (
            <div className="shortcuts__row" key={s.id}>
              <span className="shortcuts__desc">
                {s.description}
                {conflict(s.id) && <span className="shortcuts__conflict"> · conflict</span>}
              </span>
              <span className="shortcuts__keys">
                {recording === s.id ? (
                  <kbd className="shortcuts__recording">Press keys…</kbd>
                ) : (
                  <kbd>{formatCombo(comboFor(s.id))}</kbd>
                )}
                <button className="shortcuts__btn" onClick={() => setRecording(s.id)}>
                  Record
                </button>
                {overrides[s.id] && (
                  <button className="shortcuts__btn" onClick={() => reset(s.id)}>
                    Reset
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
