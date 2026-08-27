import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepoDTO } from '../../src/protocol';
import type { AgentDefinition } from '../../src/types';
import { IconFolder, IconPlus } from '../icons';
import { useSettings } from '../settings';
import { SelectField } from './select-field';

export function NewSessionModal({
  repos,
  agents,
  initialPath,
  initialAgentId,
  subtitle,
  onClose,
  onOpen,
  onBrowse,
}: {
  repos: RepoDTO[];
  agents: AgentDefinition[];
  /** Preselect this repo path when the flow is opened prefilled (N2: from a board card). */
  initialPath?: string;
  /**
   * Preselect this agent/terminal when the flow is opened from the omni-search bar
   * (R4.13: the user picked an Agent result). Takes precedence over the per-repo
   * remembered terminal on the initial render; switching repos afterward resumes the
   * normal remember-per-repo behavior.
   */
  initialAgentId?: string;
  /** Optional header subtitle override (N2: "Start a session for <card>"). */
  subtitle?: string;
  onClose: () => void;
  onOpen: (path: string, agentId: string) => void;
  onBrowse: (agentId: string) => void;
}) {
  const { settings } = useSettings();
  const preferred =
    settings.defaultAgentId && agents.some((a) => a.id === settings.defaultAgentId)
      ? settings.defaultAgentId
      : '';
  const defaultTerm = preferred || agents[0]?.id || '';
  // An explicit omni-bar agent pick wins over the per-repo remembered terminal.
  const seedAgent =
    initialAgentId && agents.some((a) => a.id === initialAgentId) ? initialAgentId : '';
  // Prefer the prefilled path (and its remembered terminal) when one is supplied.
  const initialRepo = initialPath ? repos.find((r) => r.path === initialPath) : undefined;
  // A prefill can name any folder (the Explorer's "Open as new session"), not only a known
  // repo — it gets its own row so the dialog actually shows what it is about to open.
  const prefill = initialPath && !initialRepo ? initialPath : undefined;
  const rows: { path: string; name: string; lastAgentId?: string }[] = prefill
    ? [{ path: prefill, name: prefill.split(/[\\/]/).filter(Boolean).pop() ?? prefill }, ...repos]
    : repos;
  const [sel, setSel] = useState<string | undefined>(initialPath ?? repos[0]?.path);
  const [termId, setTermId] = useState<string>(
    seedAgent || initialRepo?.lastAgentId || repos[0]?.lastAgentId || defaultTerm,
  );
  // Skip the first per-repo auto-follow when an agent was explicitly seeded, so the
  // omni-bar's choice isn't immediately clobbered by the selected repo's remembered term.
  const skipFollow = useRef(!!seedAgent);

  // Remember-per-repo: follow the selected repo's last-used terminal, else the
  // user's default terminal preference.
  useEffect(() => {
    if (skipFollow.current) {
      skipFollow.current = false;
      return;
    }
    const r = repos.find((x) => x.path === sel);
    setTermId(r?.lastAgentId ?? defaultTerm);
  }, [sel, defaultTerm, repos]);

  const open = useCallback(() => {
    if (sel && termId) onOpen(sel, termId);
  }, [sel, termId, onOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter') open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">New session</span>
          <span className="modal__sub">{subtitle ?? 'Open a repository'}</span>
        </div>

        <div className="repolist">
          {rows.map((r) => (
            <button
              key={r.path}
              className={`repo ${r.path === sel ? 'repo--active chamfer--sm' : ''}`}
              onClick={() => setSel(r.path)}
              onDoubleClick={() => onOpen(r.path, r.lastAgentId ?? termId)}
              title={r.path}
            >
              <IconFolder size={16} className="repo__icon" />
              <span className="repo__name">{r.name}</span>
              {/* The path truncates from the LEFT (.repo__path is direction: rtl) so the
                  tail — the part that tells two repos apart — survives. The LRM bookends
                  stop a leading/trailing separator (`C:\`) from flipping to the far side
                  under the RTL paragraph direction. */}
              <span className="repo__path">{`\u200e${r.path}\u200e`}</span>
            </button>
          ))}
          <button className="repo repo--browse" onClick={() => onBrowse(termId)}>
            <IconPlus size={15} className="repo__icon" />
            <span className="repo__name">Browse…</span>
          </button>
        </div>

        <div className="modal__foot">
          <div className="modal__termlabel">
            <span>Terminal</span>
            <SelectField
              ariaLabel="Terminal"
              value={termId}
              options={agents.map((a) => ({ value: a.id, label: a.label }))}
              onChange={setTermId}
            />
          </div>
          <div className="modal__actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={open} disabled={!sel || !termId}>
              Open
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
