import type { ReactNode } from 'react';
import type { RepoDTO } from '../../src/protocol';
import { formatAge, lastSessionTarget, plainShellTarget } from '../../src/start-routes';
import type { AgentDefinition } from '../../src/types';
import { post } from '../bridge';
import { IconClock, IconSparkle, IconTerminal } from '../icons';
import { useSettings } from '../settings';
import { effectiveCombo, formatComboCompact, SHORTCUT_ACTIONS } from '../shortcuts';

/**
 * Shared empty-state (M1) so every "nothing here yet" surface reads the same. `variant`
 * tunes spacing: `inline` for narrow side panels, `pane` for a full centered area,
 * `panel` for a rail that explains its own emptiness in place (§7.2).
 */
export function EmptyState({
  title,
  hint,
  icon,
  variant = 'inline',
  role,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  variant?: 'inline' | 'pane' | 'panel';
  /** e.g. 'alert' / 'status' when the empty state conveys a transient condition. */
  role?: string;
  /** Optional recovery affordance (e.g. a Retry button) rendered below the hint. */
  action?: ReactNode;
}) {
  return (
    <div className={`emptystate emptystate--${variant}`} role={role}>
      {icon && (
        <span className="emptystate__icon" aria-hidden>
          {icon}
        </span>
      )}
      <p className="emptystate__title">{title}</p>
      {hint && <p className="emptystate__hint">{hint}</p>}
      {action && <div className="emptystate__action">{action}</div>}
    </div>
  );
}

interface Route {
  id: string;
  icon: ReactNode;
  name: string;
  sub: string;
  actionId: string;
  run: () => void;
}

/**
 * The centre panel with no sessions (§7.2): what the app is for, then the real routes in,
 * ranked by position — a stack reads in one pass, three tiles compete across a line.
 */
export function CenterEmptyState({
  repos,
  agents,
  onNewSession,
}: {
  repos: RepoDTO[];
  agents: AgentDefinition[];
  onNewSession?: () => void;
}) {
  const { settings } = useSettings();
  const shell = plainShellTarget(repos, agents, settings.defaultAgentId);
  const last = lastSessionTarget(repos, agents, Date.now());

  const routes: Route[] = [];
  if (onNewSession) {
    routes.push({
      id: 'new',
      icon: <IconSparkle size={15} />,
      name: 'New session',
      sub: 'pick an agent + folder',
      actionId: 'newSession',
      run: onNewSession,
    });
  }
  if (shell) {
    routes.push({
      id: 'shell',
      icon: <IconTerminal size={15} />,
      name: 'Open a shell',
      sub: 'plain terminal, no agent',
      actionId: 'openShell',
      run: () => post({ type: 'openRepo', path: shell.path, agentId: shell.agentId }),
    });
  }
  if (last) {
    routes.push({
      id: 'reopen',
      icon: <IconClock size={15} />,
      name: 'Reopen last',
      sub: [last.repoName, last.agentLabel, formatAge(last.ageMs)].filter(Boolean).join(' · '),
      actionId: 'reopenLastSession',
      run: () => post({ type: 'openRepo', path: last.path, agentId: last.agentId }),
    });
  }

  const combo = (actionId: string): string | undefined => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
    return action ? formatComboCompact(effectiveCombo(action, settings.shortcuts)) : undefined;
  };

  return (
    <div className="center-empty">
      <div className="center-empty__intro">
        <h1 className="center-empty__title">
          <img src="./icon.png" alt="" className="center-empty__logo" aria-hidden="true" />
          Point an agent at a directory
        </h1>
        <p className="center-empty__lede">
          Conduit runs the CLI agents you already use — Claude Code, Codex, aider — side by side,
          and shows you every change before it lands.
        </p>
      </div>
      <ul className="startroutes">
        {routes.map((r, i) => (
          <li key={r.id}>
            <button
              type="button"
              className={`startroute chamfer ${i === 0 ? 'startroute--lead' : ''}`}
              onClick={r.run}
            >
              <span className="startroute__icon" aria-hidden>
                {r.icon}
              </span>
              <span className="startroute__name">{r.name}</span>
              {/* A long repo/agent pair ellipsizes rather than pushing the key cap off the row. */}
              <span className="startroute__sub" title={r.sub}>
                {r.sub}
              </span>
              {(() => {
                const c = combo(r.actionId);
                return c ? <kbd className="startroute__key">{c}</kbd> : null;
              })()}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
