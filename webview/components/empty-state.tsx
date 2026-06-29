import type { ReactNode } from 'react';

/**
 * Shared empty-state (M1) so every "nothing here yet" surface reads the same. `variant`
 * tunes spacing: `inline` for narrow side panels, `pane` for a full centered area.
 */
export function EmptyState({
  title,
  hint,
  icon,
  variant = 'inline',
  role,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  variant?: 'inline' | 'pane';
  /** e.g. 'alert' / 'status' when the empty state conveys a transient condition. */
  role?: string;
  /** Optional recovery affordance (e.g. a Retry button) rendered below the hint. */
  action?: ReactNode;
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
      {action && <div className="emptystate__action">{action}</div>}
    </div>
  );
}
