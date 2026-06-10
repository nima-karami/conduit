import { useEffect, useState } from 'react';
import type { AgentDefinition } from '../../src/types';
import type { RepoDTO } from '../../src/protocol';
import { IconFolder, IconPlus } from '../icons';
import { useSettings } from '../settings';

export function NewSessionModal({
  repos,
  agents,
  onClose,
  onOpen,
  onBrowse,
}: {
  repos: RepoDTO[];
  agents: AgentDefinition[];
  onClose: () => void;
  onOpen: (path: string, agentId: string) => void;
  onBrowse: (agentId: string) => void;
}) {
  const { settings } = useSettings();
  const preferred = settings.defaultAgentId && agents.some((a) => a.id === settings.defaultAgentId)
    ? settings.defaultAgentId
    : '';
  const defaultTerm = preferred || agents[0]?.id || '';
  const [sel, setSel] = useState<string | undefined>(repos[0]?.path);
  const [termId, setTermId] = useState<string>(repos[0]?.lastAgentId ?? defaultTerm);

  // Remember-per-repo: follow the selected repo's last-used terminal, else the
  // user's default terminal preference.
  useEffect(() => {
    const r = repos.find((x) => x.path === sel);
    setTermId(r?.lastAgentId ?? defaultTerm);
  }, [sel]);

  const open = () => {
    if (sel && termId) onOpen(sel, termId);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter') open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, termId]);

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">New session</span>
          <span className="modal__sub">Open a repository</span>
        </div>

        <div className="repolist">
          {repos.map((r) => (
            <button
              key={r.path}
              className={`repo ${r.path === sel ? 'repo--active' : ''}`}
              onClick={() => setSel(r.path)}
              onDoubleClick={() => onOpen(r.path, r.lastAgentId ?? termId)}
              title={r.path}
            >
              <IconFolder size={16} className="repo__icon" />
              <span className="repo__name">{r.name}</span>
              <span className="repo__path">{r.path}</span>
            </button>
          ))}
          <button className="repo repo--browse" onClick={() => onBrowse(termId)}>
            <IconPlus size={15} className="repo__icon" />
            <span className="repo__name">Browse…</span>
          </button>
        </div>

        <div className="modal__foot">
          <label className="modal__termlabel">
            <span>Terminal</span>
            <select className="modal__select" value={termId} onChange={(e) => setTermId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </label>
          <div className="modal__actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={open} disabled={!sel || !termId}>Open</button>
          </div>
        </div>
      </div>
    </div>
  );
}
