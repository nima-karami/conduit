import { Monitor } from 'lucide-react';
import type React from 'react';
import type { AttentionEntry } from '../../src/attention';
import { CHROME_STR, clampPercent } from '../chrome-strings';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconBranch, IconDownload, IconWorktree } from '../icons';
import { useWorkbenchChromeState } from '../workbench-chrome-state';

/** The first entry's own reason, as the old header chip titled it; null when it has none. */
function attentionReason(entry: AttentionEntry | null): string | null {
  if (entry?.kind === 'session') return entry.detail ?? null;
  if (!entry?.handle) return null;
  if (entry.kind === 'ask') return MCP_STR.ask.chipReason(entry.handle);
  return entry.reason ? MCP_STR.attention[entry.reason](entry.handle) : null;
}

/**
 * The center column's footer (sidebar-agent-tree spec §7). Counts span the window, independent of
 * the sidebar's Space/search/folds; the need-you button routes to the first projected entry.
 */
export function StatusBar(): React.JSX.Element {
  const { status, commandHint, focusAttention, update } = useWorkbenchChromeState();
  const updateLabel =
    update.status?.status === 'downloading'
      ? CHROME_STR.update.statusDownloading(clampPercent(update.status.percent))
      : update.status?.status === 'ready'
        ? CHROME_STR.update.statusReady
        : null;
  const first = status.firstAttention;
  const needYou = CHROME_STR.needYou(status.attentionCount);
  const reason = attentionReason(first);
  return (
    <footer className="statusbar" data-status-bar aria-label={CHROME_STR.statusBar}>
      <span className="statusbar__item" data-status-item="machine">
        <Monitor size={13} aria-hidden />
        <span className="statusbar__text">{CHROME_STR.machine}</span>
      </span>
      {status.branch !== null && (
        <span className="statusbar__item" data-status-item="branch" title={status.branch}>
          <IconBranch size={13} />
          <bdi className="statusbar__text">{status.branch}</bdi>
        </span>
      )}
      {status.worktree !== null && (
        <span className="statusbar__item" data-status-item="worktree" title={status.worktree}>
          <IconWorktree size={13} />
          <span className="statusbar__text">
            {CHROME_STR.worktree} <bdi>{status.worktree}</bdi>
          </span>
        </span>
      )}
      <span className="statusbar__item" data-status-item="live">
        <span className="statusbar__dot" aria-hidden />
        {CHROME_STR.agents(status.liveCount)}
      </span>
      {first && needYou && (
        <button
          type="button"
          className="statusbar__item statusbar__attn"
          data-status-item="attention"
          title={reason ?? needYou}
          onClick={() => focusAttention(first)}
        >
          <span className="statusbar__dot statusbar__dot--attn" aria-hidden />
          {needYou}
        </button>
      )}
      {updateLabel && (
        <button
          type="button"
          className="statusbar__item statusbar__update"
          data-status-item="update"
          title={updateLabel}
          aria-label={updateLabel}
          onClick={
            update.status?.status === 'ready' && update.status.releaseNotes?.trim()
              ? update.openNotes
              : update.reveal
          }
        >
          <IconDownload size={13} />
          <span className="statusbar__text">{updateLabel}</span>
        </button>
      )}
      {status.showCommandHint && commandHint !== '' && (
        <span className="statusbar__item statusbar__hint" data-status-item="commands">
          {CHROME_STR.commands(commandHint)}
        </span>
      )}
    </footer>
  );
}
