import { IconChevron } from '../icons';

interface DiffControlsBarProps {
  sideBySide: boolean;
  onToggleSideBySide: () => void;
  onPrevChange: () => void;
  onNextChange: () => void;
  hasChanges: boolean;
}

export function DiffControlsBar({
  sideBySide,
  onToggleSideBySide,
  onPrevChange,
  onNextChange,
  hasChanges,
}: DiffControlsBarProps) {
  return (
    <div className="diff-controls">
      <button
        className="iconbtn"
        title={sideBySide ? 'Switch to inline view' : 'Switch to side-by-side view'}
        onClick={onToggleSideBySide}
        aria-label={sideBySide ? 'Inline view' : 'Side-by-side view'}
      >
        {sideBySide ? '⊶' : '⊶⊷'}
      </button>
      <button
        className="iconbtn"
        title="Previous change"
        onClick={onPrevChange}
        disabled={!hasChanges}
        aria-label="Previous change"
      >
        <IconChevron className="rot-prev" />
      </button>
      <button
        className="iconbtn"
        title="Next change"
        onClick={onNextChange}
        disabled={!hasChanges}
        aria-label="Next change"
      >
        <IconChevron />
      </button>
    </div>
  );
}
