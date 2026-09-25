import type { AgentDefinition, SpawnSpec } from './types';

const defKey = (d: AgentDefinition) => JSON.stringify([d.id, d.command, d.args, d.label]);
const aliasKey = (a: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));

export class AgentRegistry {
  private agents: AgentDefinition[];
  /** `cli:<name>` → the agents.json id that shadows it (mf-new-session D20). Never listed. */
  private aliases: Record<string, string>;

  constructor(defs: AgentDefinition[], aliases?: Record<string, string>) {
    this.agents = (defs ?? []).filter(AgentRegistry.isValid);
    this.aliases = { ...aliases };
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
    const direct = this.agents.find((a) => a.id === id);
    if (direct) return direct;
    const target = Object.hasOwn(this.aliases, id) ? this.aliases[id] : undefined;
    return target === undefined ? undefined : this.agents.find((a) => a.id === target);
  }

  resolve(id: string, cwd: string): SpawnSpec {
    const a = this.get(id);
    if (!a) throw new Error(`Unknown agent: ${id}`);
    return { command: a.command, args: [...a.args], cwd };
  }

  /** In place: SessionManager and every resolve closure hold this instance. */
  replace(defs: AgentDefinition[], aliases: Record<string, string>): boolean {
    const next = (defs ?? []).filter(AgentRegistry.isValid);
    const changed =
      next.map(defKey).join('\n') !== this.agents.map(defKey).join('\n') ||
      aliasKey(aliases) !== aliasKey(this.aliases);
    this.agents = next;
    this.aliases = { ...aliases };
    return changed;
  }
}
