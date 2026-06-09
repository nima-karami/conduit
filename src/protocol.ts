import { AgentDefinition, Session } from './types';

export interface ProjectGroupDTO {
  projectPath: string;
  sessions: Session[];
}

export type HostToWebview =
  | { type: 'state'; agents: AgentDefinition[]; groups: ProjectGroupDTO[] }
  | { type: 'error'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'create'; agentId: string; projectPath: string }
  | { type: 'focus'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'kill'; id: string };
