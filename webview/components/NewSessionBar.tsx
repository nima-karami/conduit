import { useState } from 'react';
import type { AgentDefinition } from '../../src/types';
import type { WebviewToHost } from '../../src/protocol';

export function NewSessionBar({
  agents,
  post,
}: {
  agents: AgentDefinition[];
  post: (m: WebviewToHost) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [path, setPath] = useState('');
  const effectiveAgentId = agentId || agents[0]?.id || '';
  const canCreate = effectiveAgentId !== '' && path.trim().length > 0;

  return (
    <div className="newbar">
      <select value={effectiveAgentId} onChange={(e) => setAgentId(e.target.value)}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <input
        placeholder="Project folder path"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <button
        disabled={!canCreate}
        onClick={() => post({ type: 'create', agentId: effectiveAgentId, projectPath: path.trim() })}
      >
        New session
      </button>
    </div>
  );
}
