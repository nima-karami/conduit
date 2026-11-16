// The Changes tab for a remote session (plan CON-45 G4): B's repositories as a read-only list.
// Status comes from B over the link (remote-git-store); a row opens its diff, a header its history.

import type { ChangeDTO } from '../../src/protocol';
import { nameOf } from '../file-tree';
import { MACHINES_STR } from '../machines-strings';
import { type RemoteRepo, useRemoteStatus } from '../remote-git-store';
import type { RemoteSessionRow } from '../remote-sessions';

type Item =
  | { kind: 'repo'; key: string; repo: RemoteRepo }
  | { kind: 'change'; key: string; repo: RemoteRepo; change: ChangeDTO }
  | { kind: 'note'; key: string; text: string; retry?: true };

export function RemoteChangesView({
  row,
  onOpenDiff,
  onOpenHistory,
}: {
  row: RemoteSessionRow;
  /** `path` is relative to `root`, the repo B reported for the folder. */
  onOpenDiff?: (path: string, root: string) => void;
  onOpenHistory?: (root: string) => void;
}) {
  const status = useRemoteStatus(row);

  if (status.offline) {
    return (
      <div className="remote-changes">
        <p className="remote-changes__note" role="status">
          {MACHINES_STR.changesOffline(row.machineName)}
        </p>
      </div>
    );
  }

  const items: Item[] = status.loading
    ? [{ kind: 'note', key: 'loading', text: MACHINES_STR.changesLoading }]
    : status.repos.length === 0
      ? status.errors.length > 0
        ? [
            {
              kind: 'note',
              key: 'error',
              text: MACHINES_STR.paneError(status.errors[0] ?? ''),
              retry: true,
            },
          ]
        : [{ kind: 'note', key: 'no-repo', text: MACHINES_STR.changesNoRepo }]
      : status.repos.flatMap((repo): Item[] => {
          const { changes, error } = repo.snapshot;
          const header: Item = { kind: 'repo', key: `repo:${repo.root}`, repo };
          const stale: Item[] =
            error !== undefined
              ? [{ kind: 'note', key: `stale:${repo.root}`, text: MACHINES_STR.changesStale }]
              : [];
          const body: Item[] =
            changes.length === 0
              ? [{ kind: 'note', key: `clean:${repo.root}`, text: MACHINES_STR.changesNoChanges }]
              : changes.map((change) => ({
                  kind: 'change',
                  key: `change:${repo.root}:${change.staged ? 's' : 'u'}:${change.path}`,
                  repo,
                  change,
                }));
          return [header, ...stale, ...body];
        });

  return (
    <div className="remote-changes">
      <div
        role="list"
        className="remote-changes__list"
        aria-label={MACHINES_STR.changesList(row.machineName)}
      >
        {items.map((item) => {
          if (item.kind === 'repo') {
            return (
              <div key={item.key} role="listitem" className="remote-changes__repo">
                <bdi dir="ltr" className="remote-changes__name" title={item.repo.root}>
                  {nameOf(item.repo.root)}
                </bdi>
                {onOpenHistory ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => onOpenHistory(item.repo.root)}
                  >
                    {MACHINES_STR.changesHistory}
                  </button>
                ) : null}
              </div>
            );
          }
          if (item.kind === 'note') {
            return (
              <div key={item.key} role="listitem" className="remote-changes__note">
                <span>{item.text}</span>
                {item.retry ? (
                  <button type="button" className="btn btn--sm" onClick={status.retry}>
                    {MACHINES_STR.changesRetry}
                  </button>
                ) : null}
              </div>
            );
          }
          const { change, repo } = item;
          const lines = repo.snapshot.lines;
          return (
            <div key={item.key} role="listitem" className="remote-changes__entry">
              <button
                type="button"
                className="remote-changes__row"
                title={change.path}
                onClick={() => onOpenDiff?.(change.path, repo.root)}
              >
                <span className={`remote-changes__kind remote-changes__kind--${change.kind}`}>
                  {change.kind}
                </span>
                <bdi dir="ltr" className="remote-changes__path">
                  {change.path}
                </bdi>
                {change.staged ? (
                  <span className="remote-changes__staged">{MACHINES_STR.changesStaged}</span>
                ) : null}
                {lines ? (
                  <span className="remote-changes__stat">
                    <span className="remote-changes__add">+{change.added}</span>{' '}
                    <span className="remote-changes__del">−{change.removed}</span>
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
