const COUNTING_LINES = 'Counting lines…';

/** Line counts not read yet (plan 2026-10-16-multi-repo-tracking T2.7): never a guessed 0. */
export function LinesPending() {
  return <span className="diffstat--pending" role="img" aria-label={COUNTING_LINES} />;
}
