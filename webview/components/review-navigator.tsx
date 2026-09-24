import { useRef, useState } from 'react';
import { anchorMenuToRect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import { plural } from '../../src/plural';
import type { ChangeDTO, RepoChanges } from '../../src/protocol';
import { type BulkScope, buildBulkMenuItems, rowActionsFor } from '../changes-actions';
import type { GitActionIntent } from '../git-intent';
import { IconMore, IconRefresh } from '../icons';
import { reviewSourceLabel } from '../review-commit';
import type { ReviewNavGroup, ReviewNavModel } from '../review-nav-store';
import { findRepo, type ReviewFile, repoDisplayPath, rootsWithSide } from '../review-repos';
import type { ReviewScope } from '../review-scope';
import { ContextMenu, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { type NavBlock, type NavSection, ReviewFileNav } from './review-file-nav';

const STR = {
  filter: 'Filter files',
  refresh: 'Refresh changes',
  gitActions: 'Git actions',
  noMatch: 'No files match',
  emptyTitle: 'No changes',
  emptyHint: 'Nothing to review for this source.',
  staged: 'Staged',
  changes: 'Changes',
  perRepoFirst: 'Pick one repo first',
};

const MENU_W = 200;

function stagedSections(files: readonly ReviewFile[]): NavSection[] {
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);
  const sections: NavSection[] = [];
  if (staged.length > 0) sections.push({ id: 'staged', label: STR.staged, files: staged });
  if (unstaged.length > 0) sections.push({ id: 'unstaged', label: STR.changes, files: unstaged });
  return sections;
}

/** Spec 2026-09-23-mf-review §13 D6: a group's sub-labels only when it has both kinds. */
function groupBlock(g: ReviewNavGroup): NavBlock {
  const sections = stagedSections(g.files);
  return {
    group: {
      root: g.root,
      name: g.name,
      title: repoDisplayPath(g),
      reviewed: g.reviewed,
      total: g.files.length,
    },
    sections:
      sections.length > 1 ? sections : sections.map((section) => ({ ...section, label: '' })),
  };
}

function bulkScope(
  model: ReviewNavModel,
  repoChanges: readonly RepoChanges[],
): { scope: BulkScope; staged: ChangeDTO[]; unstaged: ChangeDTO[] } {
  if (model.repoRoot === null) {
    return {
      scope: {
        kind: 'all',
        stageRoots: rootsWithSide(repoChanges, false),
        unstageRoots: rootsWithSide(repoChanges, true),
        perRepoTitle: STR.perRepoFirst,
      },
      staged: [],
      unstaged: [],
    };
  }
  // Raw git sides, not the deduped card list: an MM path and the notes artifact still count.
  const changes = findRepo(repoChanges, model.repoRoot)?.changes ?? [];
  return {
    scope: { kind: 'repo', repoRoot: model.repoRoot },
    staged: changes.filter((c) => c.staged),
    unstaged: changes.filter((c) => !c.staged),
  };
}

/**
 * The Changes tab's body while review mode is on: the same file list the Review view drives,
 * with the status list's header, kebab and row actions. Fed entirely by the review-nav store,
 * so the pane never reaches into the Review view (plan Architecture, seam 1).
 */
export function ReviewNavigator({
  model,
  repoChanges,
  onAction,
  onRefresh,
  onReviewScope,
}: {
  model: ReviewNavModel | null;
  repoChanges: readonly RepoChanges[] | undefined;
  onAction: (intent: GitActionIntent) => Promise<void>;
  onRefresh?: () => void;
  /** Keeps the review's repo (spec 2026-09-23-mf-review §2.1 S2). */
  onReviewScope: (scope: ReviewScope, repoRoot?: string) => void;
}) {
  const [bulkMenu, setBulkMenu] = useState<MenuState | null>(null);
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  const source = model?.source;
  const working = source === undefined || source.kind === 'working';
  const files = model?.files ?? [];
  const totalAdd = files.reduce((a, c) => a + c.added, 0);
  const totalDel = files.reduce((a, c) => a + c.removed, 0);

  const openBulkMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (menuToggleIntent(wasOpenRef.current) === 'close') {
      setBulkMenu(null);
      return;
    }
    if (model === null) return;
    const anchor = anchorMenuToRect(e.currentTarget.getBoundingClientRect(), MENU_W);
    const { scope, staged, unstaged } = bulkScope(model, repoChanges ?? []);
    const items = buildBulkMenuItems(staged, unstaged, onAction, () => setBulkMenu(null), scope);
    setBulkMenu({ x: anchor.x, y: anchor.y, items });
  };

  const header = (
    <div className="changes__header">
      <span className="changes__header-summary">
        <span>
          {model === null
            ? '…'
            : model.groups
              ? `${plural(files.length, 'change')} · ${plural(model.groups.length, 'repo')}`
              : working
                ? plural(files.length, 'change')
                : plural(files.length, 'file')}
        </span>
        {model !== null && (
          <span className="diffstat">
            {totalAdd > 0 && <span className="diffstat--add">+{totalAdd}</span>}
            {totalAdd > 0 && totalDel > 0 && ' '}
            {totalDel > 0 && <span className="diffstat--del">-{totalDel}</span>}
          </span>
        )}
      </span>
      {model !== null && working && onRefresh && (
        <button
          type="button"
          className="iconbtn iconbtn--sm changes__refresh"
          title={STR.refresh}
          aria-label={STR.refresh}
          onClick={onRefresh}
        >
          <IconRefresh size={14} />
        </button>
      )}
      {model !== null && working && (
        <button
          ref={kebabRef}
          type="button"
          className="iconbtn iconbtn--sm changes__kebab"
          title={STR.gitActions}
          aria-label={STR.gitActions}
          aria-haspopup="menu"
          aria-expanded={bulkMenu !== null}
          onMouseDown={() => {
            wasOpenRef.current = bulkMenu !== null;
          }}
          onClick={openBulkMenu}
        >
          <IconMore size={15} />
        </button>
      )}
    </div>
  );

  if (model === null) return <div className="rnav">{header}</div>;

  const blocks: NavBlock[] = model.groups
    ? model.groups.map(groupBlock)
    : [{ sections: working ? stagedSections(files) : [{ id: 'unstaged', label: '', files }] }];

  const filtering = model.filter.trim() !== '';

  return (
    <div className="rnav">
      {header}
      {!working && <div className="rnav__caption">{reviewSourceLabel(source)}</div>}
      <div className="review__filter">
        <input
          className="review__filterinput"
          type="text"
          placeholder={STR.filter}
          aria-label={STR.filter}
          value={model.filter}
          onChange={(e) => model.onFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || model.filter === '') return;
            // Clearing the field IS this Esc; stop it before Review's chain reads it as
            // "close search / close Review".
            e.preventDefault();
            e.stopPropagation();
            model.onFilter('');
          }}
        />
        {filtering && (
          <span className="review__filtercount" aria-live="polite">
            {files.length} of {model.totalCount}
          </span>
        )}
      </div>
      {files.length === 0 ? (
        !filtering ? (
          <EmptyState title={STR.emptyTitle} hint={STR.emptyHint} />
        ) : (
          <div className="rnav__nomatch">{STR.noMatch}</div>
        )
      ) : (
        <ReviewFileNav
          blocks={blocks}
          activeKey={model.activeKey}
          reviewed={model.reviewed}
          canMark={model.canMark}
          onPick={model.onPick}
          onToggleReviewed={model.onToggleReviewed}
          rowActions={working ? rowActionsFor : undefined}
          onAction={working ? onAction : undefined}
          onSectionReview={
            working
              ? (scope) =>
                  onReviewScope(scope, source?.kind === 'working' ? source.repoRoot : undefined)
              : undefined
          }
        />
      )}
      {bulkMenu && (
        <ContextMenu menu={bulkMenu} onClose={() => setBulkMenu(null)} triggerRef={kebabRef} />
      )}
    </div>
  );
}
