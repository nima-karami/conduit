import { useId, useRef, useState } from 'react';
import type { Session } from '../../src/types';
import { useConduitMcp } from '../use-conduit-mcp';
import { type AssignmentExceptionSeed, PermissionsAssignments } from './permissions-assignments';
import { PermissionsGrants } from './permissions-grants';
import { PermissionsRoles } from './permissions-roles';

const sections = [
  { id: 'profiles', name: 'Profiles' },
  { id: 'assignments', name: 'Assignments' },
  { id: 'grants', name: 'Grants' },
] as const;

export function PermissionsSettings({
  serverConnected,
  sessions = [],
  onOpenActivity,
  exceptionSeed,
  onExceptionSeedConsumed,
}: {
  serverConnected: boolean;
  sessions?: Session[];
  onOpenActivity?: () => void;
  exceptionSeed?: AssignmentExceptionSeed | null;
  onExceptionSeedConsumed?: () => void;
}) {
  const mcp = useConduitMcp();
  const policy = mcp.state?.policy;
  const [section, setSection] = useState<(typeof sections)[number]['id']>(
    exceptionSeed ? 'assignments' : 'profiles',
  );
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabsId = useId();
  return (
    <>
      <div className="permissions-settings__tabs">
        <div role="tablist" aria-label="Permission sections">
          {sections.map(({ id, name }, index) => (
            <button
              key={id}
              ref={(node) => {
                tabButtons.current[index] = node;
              }}
              type="button"
              role="tab"
              id={tabsId + '-' + id}
              aria-selected={section === id}
              aria-controls={tabsId + '-section'}
              tabIndex={section === id ? 0 : -1}
              className={section === id ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
              onClick={() => setSection(id)}
              onKeyDown={(event) => {
                let next: number;
                if (event.key === 'ArrowRight') next = (index + 1) % sections.length;
                else if (event.key === 'ArrowLeft')
                  next = (index + sections.length - 1) % sections.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = sections.length - 1;
                else return;
                event.preventDefault();
                setSection(sections[next].id);
                tabButtons.current[next]?.focus();
              }}
            >
              {name}
            </button>
          ))}
        </div>
        {onOpenActivity && (
          <button type="button" className="btn btn--sm" onClick={() => onOpenActivity()}>
            Activity
          </button>
        )}
      </div>
      <div role="tabpanel" id={tabsId + '-section'} aria-labelledby={tabsId + '-' + section}>
        {section === 'profiles' && (
          <PermissionsRoles
            mcp={mcp}
            serverConnected={serverConnected}
            sessions={sessions}
            registerBack={() => {}}
          />
        )}
        {section !== 'profiles' && !policy && <p>Loading permissions…</p>}
        {section === 'assignments' && policy && (
          <PermissionsAssignments
            policy={policy}
            sessions={sessions}
            exceptionSeed={exceptionSeed}
            onExceptionSeedConsumed={onExceptionSeedConsumed}
            mcp={mcp}
            serverConnected={serverConnected}
          />
        )}
        {section === 'grants' && policy && (
          <PermissionsGrants
            policy={serverConnected ? policy : { ...policy, readOnly: true }}
            grantLifecycle={mcp.grantLifecycle}
          />
        )}
      </div>
    </>
  );
}
