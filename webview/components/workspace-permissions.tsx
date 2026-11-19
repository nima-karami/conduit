import { useCallback, useRef } from 'react';
import type { PolicyUiState } from '../../src/conduit-mcp/policy-types';
import type { Session } from '../../src/types';
import { useToastSide } from '../toast-floor';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { useOverlayEntry } from '../use-overlay-entry';
import type { BackHandler } from './mcp-section';
import { type AgentStage, PermissionsAssignments } from './permissions-assignments';
import type { OpenSessionActivity } from './session-permissions-details';

export function WorkspacePermissions({
  policy,
  sessions,
  mcp,
  serverConnected,
  agentKey,
  stage,
  opener,
  onClose,
  onOpenInSettings,
  onOpenActivity,
  onRelaunch,
}: {
  policy: PolicyUiState;
  sessions: Session[];
  mcp: ConduitMcpApi;
  serverConnected: boolean;
  agentKey: string;
  stage?: AgentStage;
  opener?: HTMLElement;
  onClose(): void;
  onOpenInSettings(): void;
  onOpenActivity: OpenSessionActivity;
  onRelaunch(sessionId: string, generation: number | null): Promise<void>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  useToastSide(frame);
  const stepBack = useRef<BackHandler | null>(null);
  const registerBack = useCallback((handler: BackHandler | null) => {
    stepBack.current = handler;
  }, []);
  useOverlayEntry('panel', () => {
    if (!stepBack.current?.()) onClose();
  });
  return (
    <div ref={frame} className="workspace-permissions__content chamfer">
      <PermissionsAssignments
        policy={policy}
        sessions={sessions}
        mcp={mcp}
        serverConnected={serverConnected}
        focusAgentKey={agentKey}
        focusAgentStage={stage}
        registerBack={registerBack}
        workspace={{ opener, onClose, onOpenInSettings }}
        onOpenActivity={onOpenActivity}
        onRelaunch={onRelaunch}
      />
    </div>
  );
}
