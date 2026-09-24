import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangesModel, RepoHeadModel } from '../../src/changes-view-model';
import { folderKey } from '../../src/folder-key';
import { anchorMenuToRect } from '../../src/menu-position';
import { countNoun } from '../../src/menu-selection';
import { menuToggleIntent } from '../../src/menu-toggle';
import type { ChangeDTO, DiffTabScope } from '../../src/protocol';
import { repoLabel, repoSub } from '../../src/repo-display';
import type { RepoInfo } from '../../src/repo-scan';
import type { ChangesViewMode } from '../../src/settings';
import { type BulkScope, buildBulkMenuItems, rowActionsFor } from '../changes-actions';
import { changeRowTooltip, diffScopeForChange } from '../diff-tab-scope';
import type { OpenMode } from '../docs';
import type { GitActionIntent } from '../git-intent';
import { IconCheck, IconMore, IconRefresh } from '../icons';
import { middleClickProps } from '../middle-click';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { RepoHead } from './repo-head';

const STR = {
  loading: 'Loading…',
  noChanges: 'No changes',
  changes: (n: number) => countNoun(n, 'change', 'changes'),
  repos: (n: number) => countNoun(n, 'repo', 'repos'),
  review: 'Review',
  reviewName: 'Review changes',
  refresh: 'Refresh changes',
  actions: 'Git actions',
  viewAll: 'All repos',
  viewActive: 'Active repo',
  staged: 'Staged',
  unstaged: 'Changes',
  noRepos: 'No git repos',
  noReposHint: "None of this session's folders is a git repository.",
  cleanOne: 'The working tree is clean.',
  cleanMany: (n: number) => `All ${n} repos are clean.`,
} as const;

const MENU_W = 200;

export interface ChangesViewProps {
  model: Exclude<ChangesModel, { kind: 'no-session' }>;
  /** `Review changes (<combo>)`. */
  reviewTitle: string;
  onReview: () => void;
  onRefresh: () => void;
  onSetView: (view: ChangesViewMode) => void;
  onOpenDiff: (
    repoRoot: string,
    relPath: string,
    diffScope: DiffTabScope | undefined,
    mode?: OpenMode,
  ) => void;
  onAction: (intent: GitActionIntent) => Promise<void>;
  onChangeContextMenu: (e: React.MouseEvent, relPath: string, repoRoot: string) => void;
  onRepoHeadContextMenu: (e: React.MouseEvent | React.KeyboardEvent, repoRoot: string) => void;
  onRepoContext: (repoRoot: string) => void;
  onPickActiveRepo: (root: string | null) => void;
  renderChip: (repo: RepoInfo) => React.ReactNode;
}

function ChangeRow({
  change,
  repoRoot,
  onOpenDiff,
  onAction,
  onChangeContextMenu,
  onRepoContext,
}: {
  change: ChangeDTO;
  repoRoot: string;
  onOpenDiff: ChangesViewProps['onOpenDiff'];
  onAction: ChangesViewProps['onAction'];
  onChangeContextMenu: ChangesViewProps['onChangeContextMenu'];
  onRepoContext: ChangesViewProps['onRepoContext'];
}) {
  const parts = change.path.split('/');
  const file = parts.pop() ?? change.path;
  const dir = parts.join('/');
  const actions = rowActionsFor(change);
  const open = (mode?: OpenMode) => {
    onRepoContext(repoRoot);
    onOpenDiff(repoRoot, change.path, diffScopeForChange(change), mode);
  };
  return (
    <div
      className="change"
      onClick={() => open()}
      {...middleClickProps(() => open('background'))}
      onContextMenu={(e) => onChangeContextMenu(e, change.path, repoRoot)}
      title={changeRowTooltip(change)}
    >
      <span className={`change__kind change__kind--${change.kind}`}>{change.kind}</span>
      <span className="change__path">
        {dir && <span className="change__dir">{dir}/</span>}
        <span className="change__file">{file}</span>
      </span>
      <span className="change__stat">
        {change.added > 0 && <span className="diffstat--add">+{change.added}</span>}
        {change.removed > 0 && <span className="diffstat--del"> -{change.removed}</span>}
      </span>
      <span className="change__row-actions">
        {actions.map((a) => (
          <button
            key={a.op}
            type="button"
            className={`change__action ${a.danger ? 'change__action--danger' : ''}`}
            title={a.title}
            onClick={(e) => {
              e.stopPropagation();
              onRepoContext(repoRoot);
              void onAction({ op: a.op, path: change.path, repoRoot });
            }}
          >
            {a.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function HeaderSummary({ model }: { model: ChangesViewProps['model'] }) {
  if (model.kind !== 'ready' || (model.loading && model.count === 0))
    return (
      <span className="changes__header-summary" title={STR.loading}>
        <span className="changes__header-count">{STR.loading}</span>
      </span>
    );
  if (model.count === 0)
    return (
      <span className="changes__header-summary" title={STR.noChanges}>
        <span className="changes__header-count">{STR.noChanges}</span>
      </span>
    );
  const repoPart =
    model.view === 'all' && model.repos.length >= 2 ? ` · ${STR.repos(model.repos.length)}` : '';
  const count = `${STR.changes(model.count)}${repoPart}`;
  const stat = [
    model.added > 0 ? `+${model.added}` : '',
    model.removed > 0 ? `-${model.removed}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className="changes__header-summary" title={stat ? `${count} ${stat}` : count}>
      <span className="changes__header-count">{count}</span>
      <span className="diffstat">
        {model.added > 0 && <span className="diffstat--add">+{model.added}</span>}
        {model.added > 0 && model.removed > 0 && ' '}
        {model.removed > 0 && <span className="diffstat--del">-{model.removed}</span>}
      </span>
    </span>
  );
}

export function ChangesView({
  model,
  reviewTitle,
  onReview,
  onRefresh,
  onSetView,
  onOpenDiff,
  onAction,
  onChangeContextMenu,
  onRepoHeadContextMenu,
  onRepoContext,
  onPickActiveRepo,
  renderChip,
}: ChangesViewProps) {
  const baseId = useId();
  const [bulkMenu, setBulkMenu] = useState<MenuState | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Where focus goes once a view change has rendered: the control that caused it may have
  // unmounted with the old view (spec §10 "Focus after view changes").
  const focusAfterViewRef = useRef<'kebab' | 'first-chevron' | null>(null);
  const view = model.kind === 'ready' ? model.view : undefined;

  useLayoutEffect(() => {
    const target = focusAfterViewRef.current;
    if (!target || view === undefined) return;
    focusAfterViewRef.current = null;
    if (target === 'kebab') kebabRef.current?.focus();
    else bodyRef.current?.querySelector<HTMLElement>('.repo-head__chev')?.focus();
  }, [view]);

  if (model.kind === 'no-repos') return <EmptyState title={STR.noRepos} hint={STR.noReposHint} />;

  if (model.kind === 'detecting')
    return (
      <div className="changes__header">
        <HeaderSummary model={model} />
      </div>
    );

  const setView = (next: ChangesViewMode, focus: 'kebab' | 'first-chevron') => {
    if (next === model.view) return;
    focusAfterViewRef.current = focus;
    onSetView(next);
  };

  const bulkScope = (): BulkScope =>
    model.view === 'all'
      ? {
          kind: 'all',
          stage: model.heads
            .filter((h) => h.unstaged.length > 0)
            .map((h) => ({ root: h.repo.root })),
          unstage: model.heads
            .filter((h) => h.staged.length > 0)
            .map((h) => ({ root: h.repo.root })),
        }
      : { kind: 'repo', repoRoot: model.activeRoot };

  const openBulkMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (menuToggleIntent(wasOpenRef.current) === 'close') {
      setBulkMenu(null);
      return;
    }
    const anchor = anchorMenuToRect(e.currentTarget.getBoundingClientRect(), MENU_W);
    const close = () => setBulkMenu(null);
    const radio = (label: string, value: ChangesViewMode): MenuItem => ({
      label,
      radio: true,
      checked: model.view === value,
      icon: model.view === value ? <IconCheck size={13} /> : undefined,
      onClick: () => setView(value, 'kebab'),
    });
    const staged = model.heads.flatMap((h) => h.staged);
    const unstaged = model.heads.flatMap((h) => h.unstaged);
    const [first, ...rest] = buildBulkMenuItems(
      staged,
      unstaged,
      (intent) => void onAction(intent),
      close,
      bulkScope(),
    );
    const items: MenuItem[] = [
      radio(STR.viewAll, 'all'),
      radio(STR.viewActive, 'active'),
      ...(first ? [{ ...first, separatorBefore: true }] : []),
      ...rest,
    ];
    setBulkMenu({ x: anchor.x, y: anchor.y, items });
  };

  const toggle = (root: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const k = folderKey(root);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const pickerRows = model.repos.map((r) => {
    const sub = repoSub(r);
    return {
      root: r.root,
      name: repoLabel(r, model.repos),
      tag: r.tag,
      ...(sub ? { sub } : {}),
      checked: model.pinned && folderKey(r.root) === folderKey(model.activeRoot),
    };
  });

  const rowsOf = (head: RepoHeadModel): React.ReactNode[] => {
    const root = head.repo.root;
    if (head.changes === undefined)
      return [
        <div key="loading" className="repo-head__empty">
          {STR.loading}
        </div>,
      ];
    if (head.changes.length === 0)
      return model.allClean
        ? []
        : [
            <div key="clean" className="repo-head__empty">
              {STR.noChanges}
            </div>,
          ];
    const row = (c: ChangeDTO, side: 's' | 'u') => (
      <ChangeRow
        key={`${side}:${c.path}`}
        change={c}
        repoRoot={root}
        onOpenDiff={onOpenDiff}
        onAction={onAction}
        onChangeContextMenu={onChangeContextMenu}
        onRepoContext={onRepoContext}
      />
    );
    return [
      ...(head.staged.length > 0
        ? [
            <div key="staged" className="changes__section">
              <span>{STR.staged}</span>
            </div>,
            ...head.staged.map((c) => row(c, 's')),
          ]
        : []),
      ...(head.unstaged.length > 0
        ? [
            <div key="unstaged" className="changes__section">
              <span>{STR.unstaged}</span>
            </div>,
            ...head.unstaged.map((c) => row(c, 'u')),
          ]
        : []),
    ];
  };

  return (
    <>
      <div className="changes__header">
        <HeaderSummary model={model} />
        <button
          type="button"
          className="btn btn--primary btn--sm changes__review"
          title={reviewTitle}
          aria-label={STR.reviewName}
          onClick={onReview}
        >
          {STR.review}
        </button>
        <button
          type="button"
          className="iconbtn iconbtn--sm changes__refresh"
          title={STR.refresh}
          aria-label={STR.refresh}
          onClick={onRefresh}
        >
          <IconRefresh size={14} />
        </button>
        <button
          ref={kebabRef}
          type="button"
          className="iconbtn iconbtn--sm changes__kebab"
          title={STR.actions}
          aria-label={STR.actions}
          aria-haspopup="menu"
          aria-expanded={bulkMenu !== null}
          onMouseDown={() => {
            wasOpenRef.current = bulkMenu !== null;
          }}
          onClick={openBulkMenu}
        >
          <IconMore size={15} />
        </button>
      </div>
      <div ref={bodyRef} className="right__scroll">
        {model.heads.flatMap((head, i) => {
          const root = head.repo.root;
          const listId = `${baseId}-repo-${i}`;
          const isCollapsed = model.view === 'all' && collapsed.has(folderKey(root));
          const rows = rowsOf(head);
          const listShown = !isCollapsed && rows.length > 0;
          return [
            <RepoHead
              key={`head:${root}`}
              head={head}
              view={model.view}
              tag={head.repo.tag}
              collapsed={isCollapsed}
              listId={listShown ? listId : undefined}
              onToggle={() => toggle(root)}
              picker={
                model.view === 'active' && model.repos.length >= 2
                  ? {
                      rows: pickerRows,
                      pinned: model.pinned,
                      onPick: onPickActiveRepo,
                      onShowAll: () => setView('all', 'first-chevron'),
                    }
                  : undefined
              }
              chip={renderChip(head.repo)}
              onActivate={() => onRepoContext(root)}
              onContextMenu={(e) => onRepoHeadContextMenu(e, root)}
            />,
            ...(!listShown
              ? []
              : [
                  <div key={`list:${root}`} id={listId} className="repo-head__list">
                    {rows}
                  </div>,
                ]),
          ];
        })}
        {model.allClean && (
          <EmptyState
            title={STR.noChanges}
            hint={
              model.view === 'all' && model.repos.length >= 2
                ? STR.cleanMany(model.repos.length)
                : STR.cleanOne
            }
          />
        )}
      </div>
      {bulkMenu && (
        <ContextMenu menu={bulkMenu} onClose={() => setBulkMenu(null)} triggerRef={kebabRef} />
      )}
    </>
  );
}
