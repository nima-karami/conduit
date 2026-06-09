import * as vscode from 'vscode';
import { SpawnSpec } from './types';

export interface TerminalHandle {
  readonly id: string;
}

export interface TerminalHost {
  create(spec: SpawnSpec, opts: { name: string; color?: string; icon?: string }): TerminalHandle;
  focus(handle: TerminalHandle): void;
  dispose(handle: TerminalHandle): void;
  onDidClose(cb: (handle: TerminalHandle) => void): { dispose(): void };
}

export class VsCodeTerminalHost implements TerminalHost {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private seq = 0;
  private readonly emitter = new vscode.EventEmitter<TerminalHandle>();
  private readonly sub: vscode.Disposable;

  constructor() {
    this.sub = vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of this.terminals) {
        if (term === t) {
          this.terminals.delete(id);
          this.emitter.fire({ id });
        }
      }
    });
  }

  create(spec: SpawnSpec, opts: { name: string; color?: string; icon?: string }): TerminalHandle {
    const id = `t${this.seq++}`;
    const term = vscode.window.createTerminal({
      name: opts.name,
      cwd: spec.cwd,
      env: spec.env,
      color: opts.color ? new vscode.ThemeColor(opts.color) : undefined,
      iconPath: opts.icon ? new vscode.ThemeIcon(opts.icon) : undefined,
    });
    term.sendText([spec.command, ...spec.args].join(' '), true);
    term.show(false);
    this.terminals.set(id, term);
    return { id };
  }

  focus(handle: TerminalHandle): void {
    this.terminals.get(handle.id)?.show(false);
  }

  dispose(handle: TerminalHandle): void {
    this.terminals.get(handle.id)?.dispose();
  }

  onDidClose(cb: (h: TerminalHandle) => void) {
    return this.emitter.event(cb);
  }

  cleanup(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
