import { useEffect, useRef, useState } from 'react';
import { acceptsRepoResult, branchChipModel, switchOutcome } from '../../src/branch-chip';
import type { Rect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import type { RepoInfo } from '../../src/repo-scan';
import type { GitInfo } from '../../src/types';
import { post, subscribe } from '../bridge';
import { IconBranch, IconChevronDown, IconHistory, IconWorktree } from '../icons';
import { pushToast } from '../toast-store';
import { BranchSwitcherList } from './branch-switcher-menu';
import { Popover } from './popover';

const STR = {
  unknown: '…',
  none: 'no git info',
  noneTitle: "Couldn't read this repo's git state",
  noneName: 'No git info. View history',
  uncommitted: 'Uncommitted changes',
  menu: (name: string) => `Branch menu for ${name}`,
  viewHistory: 'View history',
  switchBranch: 'Switch branch',
} as const;

export interface BranchChipProps {
  sessionId: string;
  repo: RepoInfo;
  git: GitInfo | undefined;
  onViewHistory: (root: string) => void;
  onSwitched: () => void;
  onActivate: () => void;
}

export function BranchChip({
  sessionId,
  repo,
  git,
  onViewHistory,
  onSwitched,
  onActivate,
}: BranchChipProps) {
  const model = branchChipModel(git);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [switching, setSwitching] = useState(false);
  const [announce, setAnnounce] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  // Focus returns to the chip only for a keyboard open: a programmatic focus after a mouse
  // close reads as :focus-visible and leaves a ring painted at rest.
  const openedViaKeyboardRef = useRef(false);
  const everOpenRef = useRef(false);
  const requestedRef = useRef<string | null>(null);
  const open = anchor !== null;

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'git:switchResult' || !acceptsRepoResult(msg, sessionId, repo.root)) return;
      const ref = requestedRef.current;
      if (ref === null) return;
      requestedRef.current = null;
      setSwitching(false);
      setAnchor(null);
      const outcome = switchOutcome(msg, ref);
      if ('announce' in outcome) {
        setAnnounce(outcome.announce);
        onSwitched();
      } else {
        setAnnounce(outcome.toast);
        pushToast({ message: outcome.toast, variant: outcome.variant });
      }
    });
  }, [sessionId, repo.root, onSwitched]);

  useEffect(() => {
    if (open) {
      everOpenRef.current = true;
      if (!menuRef.current?.contains(document.activeElement)) historyRef.current?.focus();
      return;
    }
    if (everOpenRef.current && openedViaKeyboardRef.current) triggerRef.current?.focus();
    everOpenRef.current = false;
  }, [open]);

  const close = () => setAnchor(null);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onActivate();
    const viaKeyboard = e.detail === 0;
    const wasOpen = viaKeyboard ? open : wasOpenRef.current;
    if (menuToggleIntent(wasOpen) === 'close') {
      close();
      return;
    }
    openedViaKeyboardRef.current = viaKeyboard;
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  };

  const onSelect = (ref: string) => {
    requestedRef.current = ref;
    setSwitching(true);
    post({ type: 'git:switch', sessionId, repoRoot: repo.root, target: { kind: 'branch', ref } });
  };

  const focusFilter = () =>
    menuRef.current?.querySelector<HTMLInputElement>('.git-branch-menu__filter')?.focus();

  const ready = model.state === 'ready' ? model : null;
  const name =
    model.state === 'ready'
      ? model.accessibleName
      : model.state === 'none'
        ? STR.noneName
        : STR.unknown;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`branch-chip${ready ? '' : ' branch-chip--muted'}${
          ready?.kind === 'detached' ? ' branch-chip--detached' : ''
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        title={ready ? ready.text : model.state === 'none' ? STR.noneTitle : undefined}
        disabled={model.state === 'unknown' || switching}
        onMouseDown={() => {
          wasOpenRef.current = open;
        }}
        onClick={onClick}
      >
        {ready ? (
          <>
            {ready.worktree && (
              <>
                <span className="branch-chip__worktree">
                  <IconWorktree size={12} className="branch-chip__glyph" />
                  <span className="branch-chip__label" dir="ltr">
                    {ready.worktree}
                  </span>
                </span>
                <span className="branch-chip__sep" aria-hidden>
                  /
                </span>
              </>
            )}
            {ready.opLabel && <span className="branch-chip__op">{ready.opLabel}</span>}
            <IconBranch size={12} className="branch-chip__glyph" />
            <span className="branch-chip__label" dir="ltr">
              {ready.text}
            </span>
            {ready.tag && <span className="branch-chip__tag">{ready.tag}</span>}
            {ready.dirty && (
              <span className="branch-chip__dirty" title={STR.uncommitted} aria-hidden />
            )}
          </>
        ) : (
          <span className="branch-chip__label">
            {model.state === 'none' ? STR.none : STR.unknown}
          </span>
        )}
        {model.state !== 'unknown' && (
          <IconChevronDown size={11} className="branch-chip__caret" aria-hidden />
        )}
      </button>
      <div className="branch-chip__live" role="status" aria-live="polite">
        {announce}
      </div>
      {anchor && (
        <Popover
          ref={menuRef}
          anchor={anchor}
          align="end"
          role="menu"
          aria-label={STR.menu(repo.name)}
          className="ctxmenu branch-chip-menu"
          triggerRef={triggerRef}
          onClose={close}
        >
          <button
            ref={historyRef}
            type="button"
            role="menuitem"
            className="ctxmenu__item"
            onClick={() => {
              close();
              onViewHistory(repo.root);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown') return;
              e.preventDefault();
              focusFilter();
            }}
          >
            <span className="ctxmenu__icon">
              <IconHistory size={13} />
            </span>
            {STR.viewHistory}
          </button>
          <div className="ctxmenu__sep" role="separator" />
          <span className="branch-chip-menu__label">{STR.switchBranch}</span>
          <BranchSwitcherList
            sessionId={sessionId}
            repoRoot={repo.root}
            switchable={!!ready?.switchable}
            switching={switching}
            onSelect={onSelect}
            onArrowUpFromFilter={() => historyRef.current?.focus()}
          />
        </Popover>
      )}
    </>
  );
}
