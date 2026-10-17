const COUNTING_LINES = 'Counting lines…';

/** Line counts not read yet (plan 2026-10-16-multi-repo-tracking T2.7): never a guessed 0. */
export function LinesPending() {
  return <span className="diffstat--pending" role="img" aria-label={COUNTING_LINES} />;
}

/** A header total over several repos. While any of them is still counting, a sum of the rest
 *  would read as the total, so the placeholder stands alone (engine runtime QA2). */
export type HeaderStat = { pending: true } | { pending: false; added: number; removed: number };

export function headerStat(linesPending: boolean, added: number, removed: number): HeaderStat {
  return linesPending ? { pending: true } : { pending: false, added, removed };
}

/** "+3 -1" for the header tooltip; empty while pending or when both are 0. */
export function headerStatText(stat: HeaderStat): string {
  if (stat.pending) return '';
  return [stat.added > 0 ? `+${stat.added}` : '', stat.removed > 0 ? `-${stat.removed}` : '']
    .filter(Boolean)
    .join(' ');
}

export function HeaderDiffstat({ stat }: { stat: HeaderStat }) {
  return (
    <span className="diffstat">
      {stat.pending ? (
        <LinesPending />
      ) : (
        <>
          {stat.added > 0 && <span className="diffstat--add">+{stat.added}</span>}
          {stat.added > 0 && stat.removed > 0 && ' '}
          {stat.removed > 0 && <span className="diffstat--del">-{stat.removed}</span>}
        </>
      )}
    </span>
  );
}
