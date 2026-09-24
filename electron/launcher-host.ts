import type { AgentRegistry } from '../src/agent-registry';
import type { FileRead } from '../src/config';
import {
  addCustomLauncher,
  bumpUsage,
  type LaunchersFile,
  parseLaunchers,
  removeCustomLauncher,
  serializeLaunchers,
} from '../src/launcher-store';
import { composeLaunchers, type LauncherDTO, type LauncherKind } from '../src/launchers';
import type { HostPlatform } from '../src/lsp-binary';
import type { AgentDefinition } from '../src/types';

export interface LauncherHostDeps {
  registry: AgentRegistry;
  /** agents.json as loaded at startup; a rescan never re-reads it (plan Decisions Needed). */
  config: readonly AgentDefinition[];
  detectShells: () => AgentDefinition[];
  detectClis: () => AgentDefinition[];
  /** Only ENOENT is "absent"; any other failure blocks launchers.json writes for the run, as
   *  projects.json does (locked L12 B2), so one bump can't replace an intact file. */
  readFile: () => FileRead;
  persist: (text: string) => void;
  /** Custom launchers are user-authored: a file we could not read losslessly is copied aside
   *  before our first write replaces it. */
  backupCorrupt: () => void;
  resolveCommand: (command: string) => string | undefined;
  platform: HostPlatform;
  now: () => number;
}

/** Anything the parser dropped or could not read counts, not just unparseable JSON. */
function isLossy(blob: string | undefined, parsed: LaunchersFile): boolean {
  if (blob === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(blob)) !== JSON.stringify(parsed);
  } catch {
    return true;
  }
}

/** Sole owner of the launcher registry's composition and of launchers.json. */
export class LauncherHost {
  private file: LaunchersFile;
  private shells: AgentDefinition[];
  private clis: AgentDefinition[];
  private kinds: Record<string, LauncherKind> = {};
  private dirty = false;
  private needsBackup: boolean;
  private readonly writable: boolean;

  constructor(private readonly deps: LauncherHostDeps) {
    const read = deps.readFile();
    const blob = read.kind === 'text' ? read.text : undefined;
    this.file = parseLaunchers(blob);
    this.writable = read.kind !== 'unreadable';
    this.needsBackup = isLossy(blob, this.file);
    this.shells = deps.detectShells();
    this.clis = deps.detectClis();
    this.compose();
  }

  rescan(): boolean {
    this.shells = this.deps.detectShells();
    this.clis = this.deps.detectClis();
    return this.compose();
  }

  bump(agentId: string): void {
    this.write(bumpUsage(this.file, agentId, this.deps.now()));
  }

  addCustom(
    commandLine: unknown,
    label: unknown,
  ): { ok: true; id: string } | { ok: false; error: string } {
    if (!this.writable) {
      return {
        ok: false,
        error: "launchers.json couldn't be read, so custom launchers can't be saved until restart",
      };
    }
    const defs = this.deps.registry.list();
    const r = addCustomLauncher(
      this.file,
      { commandLine, label },
      {
        platform: this.deps.platform,
        resolveCommand: this.deps.resolveCommand,
        takenIds: new Set(defs.map((d) => d.id)),
        takenLabels: defs.map((d) => d.label),
      },
    );
    if (!r.ok) return r;
    this.write(r.file);
    this.compose();
    return { ok: true, id: r.def.id };
  }

  removeCustom(id: unknown): boolean {
    const next = removeCustomLauncher(this.file, id);
    if (!next) return false;
    this.write(next);
    this.compose();
    return true;
  }

  dtos(): LauncherDTO[] {
    return this.deps.registry.list().map((d) => {
      const u = this.file.usage[d.id];
      const kind = this.kinds[d.id];
      return u
        ? { id: d.id, kind, uses: u.count, lastUsed: u.lastUsed }
        : { id: d.id, kind, uses: 0 };
    });
  }

  pendingFlush(): string | null {
    return this.dirty ? serializeLaunchers(this.file) : null;
  }

  private compose(): boolean {
    const set = composeLaunchers({
      shells: this.shells,
      clis: this.clis,
      config: this.deps.config,
      custom: this.file.custom,
    });
    this.kinds = set.kinds;
    return this.deps.registry.replace(set.defs, set.aliases);
  }

  private write(next: LaunchersFile): void {
    this.file = next;
    if (!this.writable) return;
    if (this.needsBackup) {
      this.deps.backupCorrupt();
      this.needsBackup = false;
    }
    this.dirty = true;
    this.deps.persist(serializeLaunchers(next));
  }
}
