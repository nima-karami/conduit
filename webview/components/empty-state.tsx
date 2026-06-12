import type { ReactNode } from 'react';

/**
 * Shared empty-state (M1). Replaces the scatter of bare-text empty messages
 * (`.sidebar__empty`, `.right__empty`, `.review__empty`, search no-results) with one
 * consistent, density-aware component so every "nothing here yet" surface reads the same.
 *
 * Purely presentational: a primary `title`, an optional secondary `hint`, and an optional
 * leading `icon`. `variant` tunes the spacing for where it sits — `inline` for narrow side
 * panels (sessions, explorer, changes, search), `pane` for a full centered area.
 */
export function EmptyState({
  title,
  hint,
  icon,
  variant = 'inline',
  role,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  variant?: 'inline' | 'pane';
  /** e.g. 'alert' / 'status' when the empty state conveys a transient condition. */
  role?: string;
}) {
  return (
    <div className={`emptystate emptystate--${variant}`} role={role}>
      {icon && (
        <span className="emptystate__icon" aria-hidden>
          {icon}
        </span>
      )}
      <p className="emptystate__title">{title}</p>
      {hint && <p className="emptystate__hint">{hint}</p>}
    </div>
  );
}
