import { type ReactNode, useEffect, useId, useRef } from 'react';
import type { Session } from '../../src/types';
import { MCP_STR, MCP_TAB_ORDER, type McpTabId } from '../conduit-mcp-strings';
import { useConduitMcp } from '../use-conduit-mcp';
import { type ActivityScope, PermissionsActivity } from './permissions-activity';
import type { ActivityExceptionSource } from './permissions-activity-why';
import { type AssignmentExceptionSeed, PermissionsAssignments } from './permissions-assignments';
import { PermissionsGrants } from './permissions-grants';
import { PermissionsRoles } from './permissions-roles';

import type { OpenSessionActivity } from './session-permissions-details';

export type BackHandler = () => boolean;

export interface McpSectionProps {
  tab: McpTabId;
  onTabChange(tab: McpTabId): void;
  settings: ReactNode;
  serverConnected: boolean;
  sessions: Session[];
  exceptionSeed?: AssignmentExceptionSeed | null;
  onExceptionSeedConsumed?(): void;
  focusedAgentKey?: string;
  onFocusAgentSpent?(): void;
  onOpenSessionActivity?: OpenSessionActivity;
  onRelaunchPermissionSession?(sessionId: string, generation: number | null): Promise<void>;
  activityScope: ActivityScope;
  activityMachines: readonly { id: string; name: string }[];
  onAddActivityException?(source: ActivityExceptionSource): void;
  registerBack(handler: BackHandler | null): void;
}

export function McpSection({
  tab,
  onTabChange,
  settings,
  serverConnected,
  sessions,
  exceptionSeed,
  onExceptionSeedConsumed,
  focusedAgentKey,
  onFocusAgentSpent,
  onOpenSessionActivity,
  onRelaunchPermissionSession,
  activityScope,
  activityMachines,
  onAddActivityException,
  registerBack,
}: McpSectionProps) {
  const mcp = useConduitMcp();
  const policy = mcp.state?.policy;
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabsId = useId();
  useEffect(() => () => registerBack(null), [registerBack]);
  return (
    <div className="mcp-section">
      <div className="mcp-section__head">
        <h2 className="mcp-section__title" id={`${tabsId}-title`}>
          {MCP_STR.sections.title}
        </h2>
        <p className="mcp-section__sub">{MCP_STR.sections.subtitle}</p>
      </div>
      <div className="mcp-section__tabs" role="tablist" aria-label={MCP_STR.sections.tablistLabel}>
        {MCP_TAB_ORDER.map((id, index) => (
          <button
            key={id}
            ref={(node) => {
              tabButtons.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${tabsId}-${id}`}
            aria-selected={tab === id}
            aria-controls={`${tabsId}-section`}
            tabIndex={tab === id ? 0 : -1}
            className={
              tab === id ? 'mcp-section__tab mcp-section__tab--active' : 'mcp-section__tab'
            }
            onClick={() => onTabChange(id)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === 'ArrowRight') next = (index + 1) % MCP_TAB_ORDER.length;
              else if (event.key === 'ArrowLeft')
                next = (index + MCP_TAB_ORDER.length - 1) % MCP_TAB_ORDER.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = MCP_TAB_ORDER.length - 1;
              else return;
              event.preventDefault();
              onTabChange(MCP_TAB_ORDER[next]);
              tabButtons.current[next]?.focus();
            }}
          >
            {MCP_STR.sections.tabs[id]}
          </button>
        ))}
      </div>
      <div
        className={
          tab === 'roles' || tab === 'agents'
            ? 'mcp-section__panel mcp-section__panel--split'
            : 'mcp-section__panel'
        }
        role="tabpanel"
        id={`${tabsId}-section`}
        aria-labelledby={`${tabsId}-${tab}`}
      >
        {tab === 'settings' && settings}
        {tab === 'roles' && (
          <PermissionsRoles
            mcp={mcp}
            serverConnected={serverConnected}
            sessions={sessions}
            registerBack={registerBack}
            onViewAgents={() => onTabChange('agents')}
          />
        )}
        {(tab === 'agents' || tab === 'grants') && !policy && <p>Loading permissions…</p>}
        {tab === 'agents' && policy && (
          <PermissionsAssignments
            policy={policy}
            sessions={sessions}
            exceptionSeed={exceptionSeed}
            onExceptionSeedConsumed={onExceptionSeedConsumed}
            mcp={mcp}
            serverConnected={serverConnected}
            focusAgentKey={focusedAgentKey}
            onFocusAgentSpent={onFocusAgentSpent}
            onOpenActivity={onOpenSessionActivity}
            onRelaunch={onRelaunchPermissionSession}
            registerBack={registerBack}
          />
        )}
        {tab === 'grants' && policy && (
          <PermissionsGrants
            policy={serverConnected ? policy : { ...policy, readOnly: true }}
            grantLifecycle={mcp.grantLifecycle}
          />
        )}
        {tab === 'activity' && (
          <PermissionsActivity
            key={JSON.stringify([
              activityScope.sessionId,
              activityScope.machineId,
              activityScope.item,
            ])}
            sessionId={activityScope.sessionId}
            machineId={activityScope.machineId}
            item={activityScope.item}
            sessions={sessions.map((s) => ({ id: s.id, name: s.name }))}
            machines={activityMachines}
            getActivity={mcp.getActivity}
            getActivityRow={mcp.getActivityRow}
            allowOnce={mcp.allowOnce}
            onAddException={onAddActivityException}
            registerBack={registerBack}
          />
        )}
      </div>
    </div>
  );
}
