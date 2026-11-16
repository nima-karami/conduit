// The Changes tab for a remote session (plan CON-45 G4): B's repositories as a read-only list.
// Status comes from B over the link (remote-git-store); a row opens its diff, a header its history.

import type { ChangeDTO } from '../../src/protocol';
import { nameOf } from '../file-tree';
import { MACHINES_STR } from '../machines-strings';
import { type RemoteRepo, type RemoteStatus, useRemoteStatus } from '../remote-git-store';
import type { RemoteSessionRow } from '../remote-sessions';

type Item =
  | { kind: 'repo'; key: string; repo: RemoteRepo }
  | { kind: 'change'; key: string; repo: RemoteRepo; change: ChangeDTO }
  /** `folder` set: the note carries a Retry for that folder's status. */
  | { kind: 'note'; key: string; text: string; name?: string; folder?: string };

/** The flat rows of the list, in section order. */
function itemsOf(status: RemoteStatus): Item[] {
  if (status.loading) return [{ kind: 'note', key: 'loading', text: MACHINES_STR.changesLoading }];
  if (status.sections.length === 0) {
    return [{ kind: 'note', key: 'no-repo', text: MACHINES_STR.changesNoRepo }];
  }
  return status.sections.flatMap((section): Item[] => {
    if (section.kind === 'error') {
      return [
        {
          kind: 'note',
          key: `error:${section.folder}`,
          text: MACHINES_STR.paneError(section.error),
          name: nameOf(section.folder),
          folder: section.folder,
        },
      ];
    }
    const { repo } = section;
    const { changes, error } = repo.snapshot;
    const header: Item = { kind: 'repo', key: `repo:${repo.root}`, repo };
    const stale: Item[] =
      error !== undefined
        ? [
            {
              kind: 'note',
              key: `stale:${repo.root}`,
              text: MACHINES_STR.changesStale,
              folder: repo.folder,
            },
          ]
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
}

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

  const items = itemsOf(status);
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
            const { folder } = item;
            return (
              <div key={item.key} role="listitem" className="remote-changes__note">
                {item.name !== undefined ? (
                  <bdi dir="ltr" className="remote-changes__name">
                    {item.name}
                  </bdi>
                ) : null}
                <span>{item.text}</span>
                {folder !== undefined ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => status.retry(folder)}
                  >
                    {MACHINES_STR.changesRetry}
                  </button>
                ) : null}
              </div>
            );
          }
          const { change, repo } = item;
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
                <span className="remote-changes__side">
                  {change.staged ? MACHINES_STR.changesStaged : MACHINES_STR.changesUnstaged}
                </span>
                {repo.snapshot.lines ? (
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
