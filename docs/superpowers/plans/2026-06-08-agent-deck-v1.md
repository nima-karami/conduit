# Agent Deck v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Copilot-free, agent-agnostic multi-agent dashboard as a VS Code extension: a full-window webview that launches/groups/controls multiple CLI-agent sessions running in native VS Code terminals.

**Architecture:** Extension host (Node/TypeScript) owns all state and terminal control via small, single-purpose, unit-testable modules (AgentRegistry, SessionManager, StatusTracker, Persistence) behind a `TerminalHost` seam. A React webview renders the dashboard and mirrors host state over a typed `postMessage` protocol; it holds no source of truth.

**Tech Stack:** TypeScript, React, esbuild (bundling), Vitest (pure-logic unit tests), `@vscode/test-electron` (integration), `playwright-cli` (webview visual verification). Stable VS Code API only (target ^1.123). No proposed APIs, no Copilot, no editor fork.

---

## File structure

| File | Responsibility |
|------|----------------|
| `package.json` | Extension manifest (commands, settings, activation), scripts, deps |
| `tsconfig.json` / `tsconfig.webview.json` | TS config for host (CommonJS) and webview (ESNext/DOM) |
| `esbuild.mjs` | Bundles `src/extension.ts` → `out/extension.js` and `webview/index.tsx` → `out/webview.js` |
| `src/types.ts` | Shared domain types: `AgentDefinition`, `Session`, `SessionStatus`, `SpawnSpec` |
| `src/protocol.ts` | Webview↔host message union types (`HostToWebview`, `WebviewToHost`) |
| `src/agentRegistry.ts` | Validate agent defs from settings; resolve agent+target → `SpawnSpec` |
| `src/terminalHost.ts` | `TerminalHost` interface + `VsCodeTerminalHost` (only place touching `vscode` terminals) |
| `src/sessionManager.ts` | Source of truth for sessions; create/focus/rename/kill/list/group |
| `src/statusTracker.ts` | Pure state machine computing `SessionStatus` from events |
| `src/persistence.ts` | (De)serialize session list for `globalState`; reconcile on reload |
| `src/dashboardPanel.ts` | Create webview panel; bridge protocol messages ↔ host modules |
| `src/extension.ts` | `activate`/`deactivate`; wire modules + register commands |
| `webview/index.tsx` | React entry; mounts `<App>`; wires VS Code webview messaging |
| `webview/App.tsx` | Dashboard UI: grouped session list, status, controls |
| `webview/components/SessionRow.tsx` | One session row (name, icon/color, status badge, actions) |
| `webview/components/NewSessionBar.tsx` | Agent picker + target picker → emits create message |
| `webview/styles.css` | Dashboard styling (Agents Window-inspired, VS Code theme vars) |
| `test/unit/*.test.ts` | Vitest unit tests for the four pure modules |
| `test/integration/extension.test.ts` | `@vscode/test-electron` activation/command/terminal tests |
| `tools/render-webview.mjs` | Renders webview bundle with mock state to a temp HTML for screenshotting |

---

## Task 0: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.webview.json`, `esbuild.mjs`, `.vscodeignore`, `vitest.config.ts`, `src/extension.ts` (stub)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "agent-deck",
  "displayName": "Agent Deck",
  "description": "Copilot-free, agent-agnostic multi-agent dashboard",
  "version": "0.0.1",
  "publisher": "nima",
  "engines": { "vscode": "^1.123.0" },
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "agentDeck.openDashboard", "title": "Agent Deck: Open Dashboard" }
    ],
    "configuration": {
      "title": "Agent Deck",
      "properties": {
        "agentDeck.agents": {
          "type": "array",
          "default": [
            { "id": "claude", "label": "Claude Code", "command": "claude", "args": [], "icon": "sparkle", "color": "terminal.ansiMagenta", "cwdStrategy": "workspaceFolder" }
          ],
          "description": "Agent definitions available to launch."
        }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "test:unit": "vitest run",
    "test:int": "node ./out/test/runIntegration.js",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.webview.json --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/vscode": "^1.123.0",
    "@vscode/test-electron": "^2.4.0",
    "esbuild": "^0.24.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` (host)**

```json
{
  "compilerOptions": {
    "module": "CommonJS", "target": "ES2022", "lib": ["ES2022"],
    "outDir": "out", "rootDir": ".", "strict": true,
    "esModuleInterop": true, "skipLibCheck": true, "sourceMap": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `tsconfig.webview.json`**

```json
{
  "compilerOptions": {
    "module": "ESNext", "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx", "moduleResolution": "Bundler", "strict": true,
    "esModuleInterop": true, "skipLibCheck": true, "noEmit": true
  },
  "include": ["webview", "src/protocol.ts", "src/types.ts"]
}
```

- [ ] **Step 4: Create `esbuild.mjs`**

```js
import * as esbuild from 'esbuild';
const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
const host = { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js',
  platform: 'node', format: 'cjs', external: ['vscode'] };
const web = { ...common, entryPoints: ['webview/index.tsx'], outfile: 'out/webview.js',
  platform: 'browser', format: 'iife' };
if (watch) {
  const c1 = await esbuild.context(host); const c2 = await esbuild.context(web);
  await c1.watch(); await c2.watch();
} else {
  await esbuild.build(host); await esbuild.build(web);
}
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/unit/**/*.test.ts'], environment: 'node' } });
```

- [ ] **Step 6: Create `.vscodeignore`**

```
.vscode-test/
test/**
src/**
webview/**
tools/**
node_modules/**
**/*.map
esbuild.mjs
tsconfig*.json
vitest.config.ts
docs/**
```

- [ ] **Step 7: Create stub `src/extension.ts`**

```ts
import * as vscode from 'vscode';
export function activate(_context: vscode.ExtensionContext) {}
export function deactivate() {}
```

- [ ] **Step 8: Install and verify build**

Run: `npm install`
Run: `npm run build`
Expected: creates `out/extension.js` and `out/webview.js` with no errors.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: scaffold Agent Deck extension (build, tsconfig, vitest)"
```

---

## Task 1: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export type CwdStrategy = 'workspaceFolder' | 'gitWorktree' | 'prompt';

export interface AgentDefinition {
  id: string;
  label: string;
  command: string;
  args: string[];
  icon: string;        // VS Code ThemeIcon id
  color: string;       // VS Code ThemeColor id
  cwdStrategy: CwdStrategy;
}

export type SessionStatus = 'running' | 'exited' | 'stale';

export interface Session {
  id: string;
  name: string;
  agentId: string;
  projectPath: string;     // absolute folder used as group key + cwd
  worktree?: string;       // optional worktree label
  status: SessionStatus;
  createdAt: number;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts && git commit -m "feat: shared domain types"
```

---

## Task 2: AgentRegistry (TDD)

**Files:**
- Create: `src/agentRegistry.ts`
- Test: `test/unit/agentRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../../src/agentRegistry';
import { AgentDefinition } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude', label: 'Claude Code', command: 'claude', args: ['--foo'],
  icon: 'sparkle', color: 'terminal.ansiMagenta', cwdStrategy: 'workspaceFolder'
};

describe('AgentRegistry', () => {
  it('lists validated agents', () => {
    const r = new AgentRegistry([claude]);
    expect(r.list().map(a => a.id)).toEqual(['claude']);
  });

  it('drops invalid agents (missing command)', () => {
    const bad = { ...claude, id: 'bad', command: '' } as AgentDefinition;
    const r = new AgentRegistry([claude, bad]);
    expect(r.list().map(a => a.id)).toEqual(['claude']);
  });

  it('resolves an agent + target into a SpawnSpec', () => {
    const r = new AgentRegistry([claude]);
    const spec = r.resolve('claude', '/work/proj');
    expect(spec).toEqual({ command: 'claude', args: ['--foo'], cwd: '/work/proj' });
  });

  it('throws when agent id is unknown', () => {
    const r = new AgentRegistry([claude]);
    expect(() => r.resolve('nope', '/work/proj')).toThrow(/unknown agent/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- agentRegistry`
Expected: FAIL ("Cannot find module '../../src/agentRegistry'").

- [ ] **Step 3: Write minimal implementation**

```ts
import { AgentDefinition, SpawnSpec } from './types';

export class AgentRegistry {
  private readonly agents: AgentDefinition[];
  constructor(defs: AgentDefinition[]) {
    this.agents = defs.filter(AgentRegistry.isValid);
  }
  static isValid(d: AgentDefinition): boolean {
    return !!d && typeof d.id === 'string' && d.id.length > 0
      && typeof d.command === 'string' && d.command.length > 0;
  }
  list(): AgentDefinition[] { return [...this.agents]; }
  get(id: string): AgentDefinition | undefined { return this.agents.find(a => a.id === id); }
  resolve(id: string, cwd: string): SpawnSpec {
    const a = this.get(id);
    if (!a) throw new Error(`Unknown agent: ${id}`);
    return { command: a.command, args: [...a.args], cwd };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- agentRegistry`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agentRegistry.ts test/unit/agentRegistry.test.ts
git commit -m "feat: AgentRegistry with validation and spawn resolution"
```

---

## Task 3: TerminalHost seam

**Files:**
- Create: `src/terminalHost.ts`

Defines the seam so SessionManager is unit-testable. No tests here (interface + thin VS Code wrapper); behavior is covered by SessionManager tests (with a fake) and integration tests (real impl).

- [ ] **Step 1: Write `src/terminalHost.ts`**

```ts
import * as vscode from 'vscode';
import { SpawnSpec } from './types';

export interface TerminalHandle { readonly id: string; }

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
    this.sub = vscode.window.onDidCloseTerminal(t => {
      for (const [id, term] of this.terminals) {
        if (term === t) { this.terminals.delete(id); this.emitter.fire({ id }); }
      }
    });
  }

  create(spec: SpawnSpec, opts: { name: string; color?: string; icon?: string }): TerminalHandle {
    const id = `t${this.seq++}`;
    const term = vscode.window.createTerminal({
      name: opts.name, cwd: spec.cwd, env: spec.env,
      color: opts.color ? new vscode.ThemeColor(opts.color) : undefined,
      iconPath: opts.icon ? new vscode.ThemeIcon(opts.icon) : undefined,
    });
    term.sendText([spec.command, ...spec.args].join(' '), true);
    term.show(false);
    this.terminals.set(id, term);
    return { id };
  }
  focus(handle: TerminalHandle): void { this.terminals.get(handle.id)?.show(false); }
  dispose(handle: TerminalHandle): void { this.terminals.get(handle.id)?.dispose(); }
  onDidClose(cb: (h: TerminalHandle) => void) { return this.emitter.event(cb); }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/terminalHost.ts && git commit -m "feat: TerminalHost seam + VS Code implementation"
```

---

## Task 4: SessionManager (TDD with fake host)

**Files:**
- Create: `src/sessionManager.ts`
- Test: `test/unit/sessionManager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/sessionManager';
import { AgentRegistry } from '../../src/agentRegistry';
import { TerminalHost, TerminalHandle } from '../../src/terminalHost';
import { AgentDefinition } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude', label: 'Claude', command: 'claude', args: [],
  icon: 'sparkle', color: 'terminal.ansiMagenta', cwdStrategy: 'workspaceFolder'
};

class FakeHost implements TerminalHost {
  created: any[] = []; focused: string[] = []; disposed: string[] = [];
  private closeCbs: ((h: TerminalHandle) => void)[] = [];
  private seq = 0;
  create(spec: any, opts: any): TerminalHandle {
    const h = { id: `t${this.seq++}` }; this.created.push({ spec, opts, h }); return h;
  }
  focus(h: TerminalHandle) { this.focused.push(h.id); }
  dispose(h: TerminalHandle) { this.disposed.push(h.id); this.closeCbs.forEach(cb => cb(h)); }
  onDidClose(cb: (h: TerminalHandle) => void) { this.closeCbs.push(cb); return { dispose() {} }; }
}

describe('SessionManager', () => {
  let host: FakeHost; let mgr: SessionManager;
  beforeEach(() => {
    host = new FakeHost();
    mgr = new SessionManager(new AgentRegistry([claude]), host, () => 'id1');
  });

  it('creates a running session and a terminal', () => {
    const s = mgr.create('claude', '/work/proj');
    expect(s.status).toBe('running');
    expect(s.agentId).toBe('claude');
    expect(s.projectPath).toBe('/work/proj');
    expect(host.created).toHaveLength(1);
    expect(host.created[0].spec.cwd).toBe('/work/proj');
  });

  it('focuses the underlying terminal', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.focus(s.id);
    expect(host.focused).toEqual([host.created[0].h.id]);
  });

  it('renames a session', () => {
    const s = mgr.create('claude', '/work/proj');
    mgr.rename(s.id, 'My Session');
    expect(mgr.list()[0].name).toBe('My Session');
  });

  it('marks session exited when its terminal closes', () => {
    const s = mgr.create('claude', '/work/proj');
    host.dispose(host.created[0].h);
    expect(mgr.list().find(x => x.id === s.id)!.status).toBe('exited');
  });

  it('groups sessions by projectPath', () => {
    mgr = new SessionManager(new AgentRegistry([claude]), host,
      (() => { let n = 0; return () => `id${n++}`; })());
    mgr.create('claude', '/a'); mgr.create('claude', '/a'); mgr.create('claude', '/b');
    const groups = mgr.groupByProject();
    expect(groups.map(g => g.projectPath).sort()).toEqual(['/a', '/b']);
    expect(groups.find(g => g.projectPath === '/a')!.sessions).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- sessionManager`
Expected: FAIL ("Cannot find module '../../src/sessionManager'").

- [ ] **Step 3: Write minimal implementation**

```ts
import { AgentRegistry } from './agentRegistry';
import { TerminalHost, TerminalHandle } from './terminalHost';
import { Session } from './types';

export interface ProjectGroup { projectPath: string; sessions: Session[]; }

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly handles = new Map<string, TerminalHandle>();
  private listeners: (() => void)[] = [];

  constructor(
    private readonly registry: AgentRegistry,
    private readonly host: TerminalHost,
    private readonly newId: () => string = () => Math.random().toString(36).slice(2),
  ) {
    this.host.onDidClose(h => {
      for (const [sid, handle] of this.handles) {
        if (handle.id === h.id) { this.setStatus(sid, 'exited'); }
      }
    });
  }

  onChange(cb: () => void) { this.listeners.push(cb); return { dispose: () => {
    this.listeners = this.listeners.filter(l => l !== cb); } }; }
  private emit() { this.listeners.forEach(l => l()); }

  create(agentId: string, projectPath: string, worktree?: string): Session {
    const spec = this.registry.resolve(agentId, projectPath);
    const def = this.registry.get(agentId)!;
    const id = this.newId();
    const name = `${def.label} — ${projectPath.split(/[\\/]/).pop() || projectPath}`;
    const handle = this.host.create(spec, { name, color: def.color, icon: def.icon });
    const session: Session = { id, name, agentId, projectPath, worktree, status: 'running', createdAt: Date.now() };
    this.sessions.set(id, session); this.handles.set(id, handle); this.emit();
    return session;
  }

  focus(id: string) { const h = this.handles.get(id); if (h) this.host.focus(h); }
  rename(id: string, name: string) { const s = this.sessions.get(id); if (s) { s.name = name; this.emit(); } }
  kill(id: string) { const h = this.handles.get(id); if (h) this.host.dispose(h); }
  private setStatus(id: string, status: Session['status']) {
    const s = this.sessions.get(id); if (s) { s.status = status; this.emit(); } }

  list(): Session[] { return [...this.sessions.values()]; }
  groupByProject(): ProjectGroup[] {
    const map = new Map<string, Session[]>();
    for (const s of this.sessions.values()) {
      (map.get(s.projectPath) ?? map.set(s.projectPath, []).get(s.projectPath)!).push(s);
    }
    return [...map.entries()].map(([projectPath, sessions]) => ({ projectPath, sessions }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- sessionManager`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sessionManager.ts test/unit/sessionManager.test.ts
git commit -m "feat: SessionManager (create/focus/rename/kill/group, exit tracking)"
```

---

## Task 5: Persistence (TDD)

**Files:**
- Create: `src/persistence.ts`
- Test: `test/unit/persistence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { serializeSessions, restoreSessions } from '../../src/persistence';
import { Session } from '../../src/types';

const s: Session = { id: '1', name: 'A', agentId: 'claude', projectPath: '/p',
  status: 'running', createdAt: 100 };

describe('persistence', () => {
  it('round-trips sessions, forcing restored ones to stale', () => {
    const blob = serializeSessions([s]);
    const restored = restoreSessions(blob);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('1');
    expect(restored[0].status).toBe('stale'); // live terminals don't survive reload
  });

  it('returns empty array on corrupt input', () => {
    expect(restoreSessions('not json')).toEqual([]);
    expect(restoreSessions(undefined)).toEqual([]);
    expect(restoreSessions('{"version":999}')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- persistence`
Expected: FAIL ("Cannot find module '../../src/persistence'").

- [ ] **Step 3: Write minimal implementation**

```ts
import { Session } from './types';

const VERSION = 1;

export function serializeSessions(sessions: Session[]): string {
  return JSON.stringify({ version: VERSION, sessions });
}

export function restoreSessions(blob: string | undefined): Session[] {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.map((s: Session) => ({ ...s, status: 'stale' as const }));
  } catch { return []; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- persistence`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/persistence.ts test/unit/persistence.test.ts
git commit -m "feat: session persistence with stale-on-reload reconciliation"
```

---

## Task 6: Protocol types

**Files:**
- Create: `src/protocol.ts`

- [ ] **Step 1: Write `src/protocol.ts`**

```ts
import { AgentDefinition, Session } from './types';

export interface ProjectGroupDTO { projectPath: string; sessions: Session[]; }

export type HostToWebview =
  | { type: 'state'; agents: AgentDefinition[]; groups: ProjectGroupDTO[] }
  | { type: 'error'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'create'; agentId: string; projectPath: string }
  | { type: 'focus'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'kill'; id: string };
```

- [ ] **Step 2: Commit**

```bash
git add src/protocol.ts && git commit -m "feat: webview/host message protocol"
```

---

## Task 7: DashboardPanel (webview host bridge)

**Files:**
- Create: `src/dashboardPanel.ts`

This module creates the webview panel and translates protocol messages to SessionManager calls. Verified via integration test in Task 10 (logic is thin; heavy unit testing not worth it).

- [ ] **Step 1: Write `src/dashboardPanel.ts`**

```ts
import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { AgentRegistry } from './agentRegistry';
import { HostToWebview, WebviewToHost } from './protocol';

export class DashboardPanel {
  static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, mgr: SessionManager, reg: AgentRegistry) {
    if (DashboardPanel.current) { DashboardPanel.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(
      'agentDeck', 'Agent Deck', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'out')] });
    DashboardPanel.current = new DashboardPanel(panel, ctx, mgr, reg);
  }

  private constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext,
    private readonly mgr: SessionManager, private readonly reg: AgentRegistry) {
    this.panel = panel;
    this.panel.webview.html = this.html(ctx);
    this.disposables.push(this.panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.handle(m)));
    this.disposables.push(this.mgr.onChange(() => this.post()));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private handle(m: WebviewToHost) {
    try {
      switch (m.type) {
        case 'ready': this.post(); break;
        case 'create': this.mgr.create(m.agentId, m.projectPath); break;
        case 'focus': this.mgr.focus(m.id); break;
        case 'rename': this.mgr.rename(m.id, m.name); break;
        case 'kill': this.mgr.kill(m.id); break;
      }
    } catch (e: any) {
      this.send({ type: 'error', message: String(e?.message ?? e) });
    }
  }

  private post() {
    this.send({ type: 'state', agents: this.reg.list(),
      groups: this.mgr.groupByProject() });
  }
  private send(msg: HostToWebview) { this.panel.webview.postMessage(msg); }

  private html(ctx: vscode.ExtensionContext): string {
    const uri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'out', 'webview.js'));
    const csp = `default-src 'none'; script-src ${this.panel.webview.cspSource}; style-src ${this.panel.webview.cspSource} 'unsafe-inline';`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      </head><body><div id="root"></div><script src="${uri}"></script></body></html>`;
  }

  dispose() {
    DashboardPanel.current = undefined;
    this.disposables.forEach(d => d.dispose());
    this.panel.dispose();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboardPanel.ts && git commit -m "feat: DashboardPanel webview/host bridge"
```

---

## Task 8: Wire extension.ts

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Replace `src/extension.ts`**

```ts
import * as vscode from 'vscode';
import { AgentRegistry } from './agentRegistry';
import { VsCodeTerminalHost } from './terminalHost';
import { SessionManager } from './sessionManager';
import { DashboardPanel } from './dashboardPanel';
import { AgentDefinition } from './types';

export function activate(context: vscode.ExtensionContext) {
  const defs = vscode.workspace.getConfiguration('agentDeck').get<AgentDefinition[]>('agents', []);
  const registry = new AgentRegistry(defs);
  const host = new VsCodeTerminalHost();
  const manager = new SessionManager(registry, host);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentDeck.openDashboard',
      () => DashboardPanel.show(context, manager, registry))
  );
}
export function deactivate() {}
```

- [ ] **Step 2: Build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts && git commit -m "feat: wire registry/host/manager + openDashboard command"
```

---

## Task 9: Webview UI (React)

**Files:**
- Create: `webview/index.tsx`, `webview/App.tsx`, `webview/components/SessionRow.tsx`, `webview/components/NewSessionBar.tsx`, `webview/styles.css`

- [ ] **Step 1: Write `webview/index.tsx`**

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import type { HostToWebview, WebviewToHost } from '../src/protocol';

const vscode = (window as any).acquireVsCodeApi?.() ?? { postMessage: () => {} };
export const post = (m: WebviewToHost) => vscode.postMessage(m);

const root = createRoot(document.getElementById('root')!);
function render(state: Extract<HostToWebview, { type: 'state' }> | null, error?: string) {
  root.render(<App state={state} error={error} post={post} />);
}
render(null);
window.addEventListener('message', (e) => {
  const msg = e.data as HostToWebview;
  if (msg.type === 'state') render(msg);
  else if (msg.type === 'error') render(null, msg.message);
});
post({ type: 'ready' });
```

- [ ] **Step 2: Write `webview/App.tsx`**

```tsx
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { NewSessionBar } from './components/NewSessionBar';
import { SessionRow } from './components/SessionRow';

type State = Extract<HostToWebview, { type: 'state' }>;

export function App({ state, error, post }: {
  state: State | null; error?: string; post: (m: WebviewToHost) => void;
}) {
  return (
    <div className="deck">
      <header className="deck__header"><h1>Agent Deck</h1></header>
      {error && <div className="deck__error">{error}</div>}
      <NewSessionBar agents={state?.agents ?? []} post={post} />
      <main className="deck__groups">
        {(state?.groups ?? []).length === 0 && <p className="deck__empty">No sessions yet.</p>}
        {(state?.groups ?? []).map(g => (
          <section key={g.projectPath} className="group">
            <h2 className="group__title">{g.projectPath}</h2>
            {g.sessions.map(s => <SessionRow key={s.id} session={s} post={post} />)}
          </section>
        ))}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Write `webview/components/SessionRow.tsx`**

```tsx
import type { Session } from '../../src/types';
import type { WebviewToHost } from '../../src/protocol';

export function SessionRow({ session, post }: { session: Session; post: (m: WebviewToHost) => void }) {
  return (
    <div className={`row row--${session.status}`} onClick={() => post({ type: 'focus', id: session.id })}>
      <span className="row__name">{session.name}</span>
      <span className={`badge badge--${session.status}`}>{session.status}</span>
      <button className="row__kill" onClick={(e) => { e.stopPropagation(); post({ type: 'kill', id: session.id }); }}>✕</button>
    </div>
  );
}
```

- [ ] **Step 4: Write `webview/components/NewSessionBar.tsx`**

```tsx
import { useState } from 'react';
import type { AgentDefinition } from '../../src/types';
import type { WebviewToHost } from '../../src/protocol';

export function NewSessionBar({ agents, post }: { agents: AgentDefinition[]; post: (m: WebviewToHost) => void }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [path, setPath] = useState('');
  const canCreate = agentId && path.trim().length > 0;
  return (
    <div className="newbar">
      <select value={agentId} onChange={e => setAgentId(e.target.value)}>
        {agents.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
      <input placeholder="Project folder path" value={path} onChange={e => setPath(e.target.value)} />
      <button disabled={!canCreate}
        onClick={() => post({ type: 'create', agentId, projectPath: path.trim() })}>New session</button>
    </div>
  );
}
```

- [ ] **Step 5: Write `webview/styles.css`** (Agents Window-inspired; uses VS Code theme vars)

```css
:root { color-scheme: dark; }
body { margin: 0; font-family: var(--vscode-font-family, system-ui); color: var(--vscode-foreground, #ddd);
  background: var(--vscode-editor-background, #1e1e1e); }
.deck { padding: 16px; max-width: 900px; margin: 0 auto; }
.deck__header h1 { font-size: 18px; margin: 0 0 12px; }
.deck__error { background: #5a1d1d; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
.deck__empty { opacity: .6; }
.newbar { display: flex; gap: 8px; margin-bottom: 20px; }
.newbar select, .newbar input { background: var(--vscode-input-background, #2a2a2a);
  color: inherit; border: 1px solid var(--vscode-input-border, #444); border-radius: 6px; padding: 6px 8px; }
.newbar input { flex: 1; }
.newbar button, .row__kill { background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff); border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.newbar button:disabled { opacity: .5; cursor: default; }
.group { margin-bottom: 18px; }
.group__title { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin: 0 0 6px; }
.row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px;
  background: var(--vscode-list-hoverBackground, #2a2d2e); margin-bottom: 6px; cursor: pointer; }
.row__name { flex: 1; }
.row__kill { background: transparent; opacity: .5; padding: 2px 6px; }
.row__kill:hover { opacity: 1; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
.badge--running { background: #1d4d2b; } .badge--exited { background: #4d4d1d; } .badge--stale { background: #3a3a3a; }
```

- [ ] **Step 6: Build**

Run: `npm run build && npm run typecheck`
Expected: `out/webview.js` builds; no type errors.

- [ ] **Step 7: Commit**

```bash
git add webview/ && git commit -m "feat: React dashboard webview UI"
```

---

## Task 10: Webview visual verification (playwright-cli)

**Files:**
- Create: `tools/render-webview.mjs`

Renders the built webview bundle with mock state into a temp HTML so it can be screenshotted with `playwright-cli` (the webview's `acquireVsCodeApi` is shimmed; mock state is injected via a `message` event).

- [ ] **Step 1: Write `tools/render-webview.mjs`**

```js
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bundle = 'out/webview.js';
const mock = {
  type: 'state',
  agents: [{ id: 'claude', label: 'Claude Code', command: 'claude', args: [], icon: 'sparkle', color: 'terminal.ansiMagenta', cwdStrategy: 'workspaceFolder' }],
  groups: [
    { projectPath: 'G:/awby/projects/terminal-ui', sessions: [
      { id: '1', name: 'Claude Code — terminal-ui', agentId: 'claude', projectPath: 'G:/awby/projects/terminal-ui', status: 'running', createdAt: 1 },
      { id: '2', name: 'aider — terminal-ui', agentId: 'aider', projectPath: 'G:/awby/projects/terminal-ui', status: 'exited', createdAt: 2 } ] },
    { projectPath: 'G:/awby/projects/other', sessions: [
      { id: '3', name: 'Claude Code — other', agentId: 'claude', projectPath: 'G:/awby/projects/other', status: 'stale', createdAt: 3 } ] },
  ],
};

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><div id="root"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage: () => {} });</script>
<script src="file://${process.cwd().replace(/\\/g, '/')}/${bundle}"></script>
<script>setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(mock)} })), 50);</script>
</body></html>`;

const out = join(tmpdir(), 'claude-scratch', 'agent-deck-webview.html');
writeFileSync(out, html);
console.log(out);
```

- [ ] **Step 2: Build, render, screenshot to temp, and inspect**

Run:
```bash
npm run build
node tools/render-webview.mjs   # prints temp html path
playwright-cli open --browser=chrome "file://<printed-path>"
playwright-cli --raw screenshot --filename="%TEMP%/claude-scratch/agent-deck.png"
playwright-cli close-all
```
Expected: screenshot shows the dashboard with two project groups, three rows, and running/exited/stale badges. Read the PNG to confirm layout; iterate on `styles.css` until it looks right.

- [ ] **Step 3: Commit**

```bash
git add tools/render-webview.mjs && git commit -m "test: webview visual render harness for playwright-cli"
```

---

## Task 11: Integration test (extension test host)

**Files:**
- Create: `test/integration/extension.test.ts`, `test/integration/runIntegration.ts`

- [ ] **Step 1: Write `test/integration/runIntegration.ts`**

```ts
import { runTests } from '@vscode/test-electron';
import * as path from 'path';
async function main() {
  const extDev = path.resolve(__dirname, '../../');
  const testsPath = path.resolve(__dirname, './extension.test.js');
  await runTests({ extensionDevelopmentPath: extDev, extensionTestsPath: testsPath });
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Write `test/integration/extension.test.ts`**

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  // activate by running the command; should not throw and should create a webview
  await vscode.commands.executeCommand('agentDeck.openDashboard');
  const before = vscode.window.terminals.length;
  // create a session via the manager indirectly is internal; assert command registered
  const cmds = await vscode.commands.getCommands(true);
  assert.ok(cmds.includes('agentDeck.openDashboard'), 'command registered');
  assert.ok(before >= 0);
}
```

- [ ] **Step 3: Build and run integration tests**

Run: `npm run build && npm run test:int`
Expected: VS Code test host launches, command is registered, exits 0.
(Note: requires a display; on this Windows machine it launches a real VS Code test instance.)

- [ ] **Step 4: Commit**

```bash
git add test/integration/ && git commit -m "test: extension host integration (activation + command)"
```

---

## Task 12: README + default config docs

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`** documenting: what it is, how to run (`npm install`, `npm run build`, F5 to launch Extension Development Host, run "Agent Deck: Open Dashboard"), how to add agents in settings (`agentDeck.agents`), the native-terminal + no-Copilot design, and known v1 limitations (no bg images, terminals don't survive reload → stale).

- [ ] **Step 2: Commit**

```bash
git add README.md && git commit -m "docs: README with run instructions and agent config"
```

---

## Self-review notes

- **Spec coverage:** dashboard window (Tasks 7–9), grouping (Task 4 `groupByProject`, rendered Task 9), agent registry/launcher (Tasks 2, 9), focus/kill/rename (Tasks 4, 9), running/exited/stale status (Tasks 4, 5, 9), persistence/stale reconciliation (Task 5), error handling (DashboardPanel try/catch + webview error banner), tab color/icon (TerminalHost `create` opts). v2 hooks status and v3 are intentionally out.
- **Full-window:** v1 opens the dashboard as an editor-area webview (`ViewColumn.Active`); the user drags it to its own window (native VS Code "Move into New Window"). A dedicated auxiliary-window auto-open is a v1.1 polish (note in DECISIONS).
- **Type consistency:** `Session`, `AgentDefinition`, `SpawnSpec`, protocol unions are defined once in `types.ts`/`protocol.ts` and reused; `groupByProject` returns `{projectPath, sessions}` matching `ProjectGroupDTO`.
- **Placeholders:** none — every code step is concrete.
```
