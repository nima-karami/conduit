/**
 * Repo picker (multi-repo awareness). When the opened folder contains several git repos, this
 * shows which one the git surfaces (branch indicator, history, Changes) are scoped to, and lets
 * the user pick another (pinning it) or return to "Auto" (context-following). Self-hides for
 * 0–1 repos so single-repo projects look unchanged. State is host-authoritative (rides
 * `session.repos`/`activeRepoRoot`/`repoPinned`); this only reads it and posts intent.
 * See docs/specs/archive/2026-06-25-multi-repo-awareness.md.
 */
import { useRef, useState } from 'react';
import type { RepoInfo } from '../../src/protocol';
import { post } from '../bridge';
import { IconChevronDown, IconFolder, IconPin } from '../icons';
import { RepoPickerMenu } from './repo-picker-menu';

const STR = {
  label: 'Active repo',
  auto: 'Auto (follow context)',
  pinnedHint: 'pinned',
} as const;

export function RepoPicker({
  sessionId,
  repos,
  activeRepoRoot,
  pinned,
}: {
  sessionId: string;
  repos: RepoInfo[];
  activeRepoRoot?: string;
  pinned?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Self-hide for single-repo / no-repo projects (nothing to choose).
  if (repos.length < 2) return null;

  const active = repos.find((r) => r.root === activeRepoRoot);
  const onPick = (root: string | null) => {
    post(
      root === null
        ? { type: 'repo:unpin', sessionId }
        : { type: 'repo:pin', sessionId, repoRoot: root },
    );
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="repo-picker" role="group" aria-label={STR.label}>
      <button
        ref={triggerRef}
        type="button"
        className="repo-picker__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${STR.label}: ${active?.name ?? '—'}${pinned ? `, ${STR.pinnedHint}` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconFolder size={12} className="repo-picker__glyph" />
        <span className="repo-picker__name" dir="ltr">
          {active?.name ?? '—'}
        </span>
        {pinned && <IconPin size={11} className="repo-picker__pin" aria-hidden />}
        <IconChevronDown size={11} className="repo-picker__caret" aria-hidden />
      </button>
      {open && (
        <RepoPickerMenu
          repos={repos}
          activeRepoRoot={activeRepoRoot}
          pinned={pinned}
          autoLabel={STR.auto}
          triggerRef={triggerRef}
          onPick={onPick}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
