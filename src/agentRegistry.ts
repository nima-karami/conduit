import { AgentDefinition, SpawnSpec } from './types';

export class AgentRegistry {
  private readonly agents: AgentDefinition[];

  constructor(defs: AgentDefinition[]) {
    this.agents = (defs ?? []).filter(AgentRegistry.isValid);
  }

  static isValid(d: AgentDefinition): boolean {
    return (
      !!d &&
      typeof d.id === 'string' &&
      d.id.length > 0 &&
      typeof d.command === 'string' &&
      d.command.length > 0
    );
  }

  list(): AgentDefinition[] {
    return [...this.agents];
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.find((a) => a.id === id);
  }

  resolve(id: string, cwd: string): SpawnSpec {
    const a = this.get(id);
    if (!a) throw new Error(`Unknown agent: ${id}`);
    return { command: a.command, args: [...a.args], cwd };
  }
}
