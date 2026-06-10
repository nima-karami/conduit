# File Browser + Code/Markdown Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive file tree, a Monaco read-only code/markdown viewer, and click-to-diff for git Changes to Agent Deck, with opened documents living as tabs in the center editor area beside the terminal.

**Architecture:** A new host-side `fileService` (fs + injected `git show`) answers three IPC requests — `readDir`, `readFile`, `readDiff`. The webview gains a pure open-documents reducer and Monaco-based viewer components. The center pane becomes a tab strip (Terminal + document tabs); the terminal stays mounted (hidden) when a document is active. Read-only v1, shaped so editing drops in later.

**Tech Stack:** Electron + React + esbuild (existing); `monaco-editor` (viewer + diff), `react-markdown` + `remark-gfm` + `rehype-highlight` (markdown), `vitest` (unit tests).

---

## File Structure

- `src/protocol.ts` (modify) — add `DirEntryDTO`, `FileContentDTO`, `FileDiffDTO`; add `readDir`/`readFile`/`readDiff` (→host) and `dirEntries`/`fileContent`/`fileDiff` (→webview).
- `src/fileService.ts` (create) — `langFromPath`, `isBinary`, `sortEntries` (pure) + `readDir`, `readFile`, `readDiff` (async; `git show` injected).
- `electron/main.ts` (modify) — `gitShow` helper + handlers for the three messages.
- `webview/docs.ts` (create) — open-documents reducer (pure).
- `webview/monacoSetup.ts` (create) — `MonacoEnvironment.getWorker` wiring.
- `webview/components/CodeViewer.tsx` (create) — Monaco read-only.
- `webview/components/MarkdownViewer.tsx` (create) — react-markdown.
- `webview/components/DiffViewer.tsx` (create) — Monaco diff editor.
- `webview/components/DocView.tsx` (create) — picks the right viewer for a document.
- `webview/components/DocTabs.tsx` (create) — center tab strip (Terminal + docs).
- `webview/components/CenterPane.tsx` (modify) — host the tab strip + active content.
- `webview/components/RightPane.tsx` (modify) — interactive tree (lazy) + Changes click-to-diff.
- `webview/App.tsx` (modify) — docs reducer state, content cache, handlers.
- `webview/bridge.ts` + `webview/mock.ts` (modify) — mock the three messages for the browser preview.
- `webview/monaco-theme.ts` (create) — custom dark theme.
- `esbuild.mjs` (modify) — Monaco editor-worker bundle, `.ttf` loader, CSP `worker-src`.
- `test/unit/fileService.test.ts`, `test/unit/docs.test.ts` (create) — unit tests.

---

## Task 1: Dependencies, Monaco worker bundling, CSP

**Files:**
- Modify: `package.json` (deps)
- Modify: `esbuild.mjs`
- Create: `webview/monacoSetup.ts`
- Modify: `webview/index.tsx`

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install monaco-editor react-markdown remark-gfm rehype-highlight highlight.js
```
Expected: added to `dependencies`, no errors.

- [ ] **Step 2: Add the Monaco editor-worker bundle, `.ttf` loader, and HTML to esbuild**

In `esbuild.mjs`, add a `.ttf` file loader to the `web` config and a new `monacoWorker` build, and include it in both the watch and build arms.

Replace the `web` config object with:
```js
const web = {
  ...common,
  entryPoints: ['webview/index.tsx'],
  outfile: 'out/webview.js',
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  loader: { '.ttf': 'file' }, // Monaco's codicon font
};

// Monaco's editor worker (needed for diff computation + colorization services).
const monacoWorker = {
  ...common,
  entryPoints: { 'monaco-editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js' },
  outdir: 'out',
  platform: 'browser',
  format: 'iife',
};
```

Update the watch arm:
```js
if (watch) {
  const ctxs = await Promise.all([main, preload, web, monacoWorker].map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  writeHtml();
} else {
  await Promise.all([main, preload, web, monacoWorker].map((c) => esbuild.build(c)));
  writeHtml();
}
```

- [ ] **Step 3: Allow workers in the renderer CSP**

In `esbuild.mjs`, in the `indexHtml` CSP string, add `worker-src 'self';` (after `font-src ...`). New CSP line:
```
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; worker-src 'self'; connect-src 'self';">
```

- [ ] **Step 4: Wire the Monaco worker environment**

Create `webview/monacoSetup.ts`:
```ts
// Point Monaco at its bundled worker (out/monaco-editor.worker.js, loaded relative
// to index.html). Must run before any monaco-editor import is used.
type MonacoEnv = { getWorker: () => Worker };
(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker: () => new Worker('./monaco-editor.worker.js'),
};
```

- [ ] **Step 5: Import the setup first in the entry**

In `webview/index.tsx`, make the FIRST import:
```tsx
import './monacoSetup';
```
(Above the existing `react-dom/client` import.)

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: success; `out/` now contains `monaco-editor.worker.js` and a hashed `.ttf`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json esbuild.mjs webview/monacoSetup.ts webview/index.tsx
git commit -m "build: bundle Monaco editor worker + deps for the code viewer"
```

---

## Task 2: Protocol DTOs and messages

**Files:**
- Modify: `src/protocol.ts`

- [ ] **Step 1: Add the DTOs**

In `src/protocol.ts`, after the `RepoDTO` interface, add:
```ts
export interface DirEntryDTO {
  name: string;
  kind: 'dir' | 'file';
}

export interface FileContentDTO {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  binary: boolean;
}

export interface FileDiffDTO {
  path: string;
  head: string;
  work: string;
  binary: boolean;
}
```

- [ ] **Step 2: Add host→webview responses**

In the `HostToWebview` union, add:
```ts
  | { type: 'dirEntries'; path: string; entries: DirEntryDTO[] }
  | { type: 'fileContent'; doc: FileContentDTO }
  | { type: 'fileDiff'; doc: FileDiffDTO }
```

- [ ] **Step 3: Add webview→host requests**

In the `WebviewToHost` union, add (after `requestProject`):
```ts
  | { type: 'readDir'; path: string }
  | { type: 'readFile'; path: string }
  | { type: 'readDiff'; path: string }
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (new members are additive).

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts
git commit -m "feat: protocol DTOs/messages for file read + diff"
```

---

## Task 3: fileService pure helpers (TDD)

**Files:**
- Create: `src/fileService.ts`
- Test: `test/unit/fileService.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/fileService.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { langFromPath, isBinary, sortEntries } from '../../src/fileService';
import type { DirEntryDTO } from '../../src/protocol';

describe('fileService helpers', () => {
  it('infers Monaco language ids from extension', () => {
    expect(langFromPath('a/b.ts')).toBe('typescript');
    expect(langFromPath('x.TSX')).toBe('typescript');
    expect(langFromPath('readme.md')).toBe('markdown');
    expect(langFromPath('Makefile')).toBe('plaintext');
  });

  it('detects binary content via NUL bytes', () => {
    expect(isBinary(Buffer.from('hello world'))).toBe(false);
    expect(isBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
  });

  it('sorts directories first, then by name (case-insensitive)', () => {
    const input: DirEntryDTO[] = [
      { name: 'b.ts', kind: 'file' },
      { name: 'src', kind: 'dir' },
      { name: 'A.ts', kind: 'file' },
      { name: 'lib', kind: 'dir' },
    ];
    expect(sortEntries(input).map((e) => e.name)).toEqual(['lib', 'src', 'A.ts', 'b.ts']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- fileService`
Expected: FAIL (`src/fileService` not found).

- [ ] **Step 3: Implement the helpers**

Create `src/fileService.ts`:
```ts
import * as fs from 'fs';
import { DirEntryDTO, FileContentDTO, FileDiffDTO } from './protocol';

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.vscode-test']);
const MAX_BYTES = 2 * 1024 * 1024;

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  json: 'json', md: 'markdown', markdown: 'markdown', css: 'css', scss: 'scss', html: 'html',
  py: 'python', rs: 'rust', go: 'go', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby',
  php: 'php', sql: 'sql', xml: 'xml', svg: 'xml',
};

export function langFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return LANG[ext] ?? 'plaintext';
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function sortEntries(entries: DirEntryDTO[]): DirEntryDTO[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- fileService`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fileService.ts test/unit/fileService.test.ts
git commit -m "feat: fileService pure helpers (lang/binary/sort) + tests"
```

---

## Task 4: fileService async readers (TDD)

**Files:**
- Modify: `src/fileService.ts`
- Test: `test/unit/fileService.test.ts`

- [ ] **Step 1: Write the failing test (append)**

Append to `test/unit/fileService.test.ts`:
```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDir, readFile, readDiff } from '../../src/fileService';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsvc-'));
}

describe('fileService readers', () => {
  it('readDir lists entries (dirs first) and skips ignored', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'node_modules'));
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'a.ts'), 'x');
    const entries = await readDir(d);
    expect(entries.map((e) => e.name)).toEqual(['src', 'a.ts']);
  });

  it('readFile returns content + language', async () => {
    const d = tmp();
    const f = path.join(d, 'x.ts');
    fs.writeFileSync(f, 'const a = 1;');
    const doc = await readFile(f);
    expect(doc).toMatchObject({ content: 'const a = 1;', language: 'typescript', binary: false, truncated: false });
  });

  it('readFile flags binary files', async () => {
    const d = tmp();
    const f = path.join(d, 'b.bin');
    fs.writeFileSync(f, Buffer.from([1, 0, 2]));
    const doc = await readFile(f);
    expect(doc.binary).toBe(true);
    expect(doc.content).toBe('');
  });

  it('readDiff combines working file + injected HEAD content', async () => {
    const d = tmp();
    const f = path.join(d, 'x.ts');
    fs.writeFileSync(f, 'new');
    const diff = await readDiff(f, async () => 'old');
    expect(diff).toMatchObject({ work: 'new', head: 'old', binary: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- fileService`
Expected: FAIL (`readDir`/`readFile`/`readDiff` not exported).

- [ ] **Step 3: Implement the readers (append to `src/fileService.ts`)**

```ts
export async function readDir(absPath: string): Promise<DirEntryDTO[]> {
  try {
    const ents = await fs.promises.readdir(absPath, { withFileTypes: true });
    const mapped: DirEntryDTO[] = ents
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => ({ name: e.name, kind: (e.isDirectory() ? 'dir' : 'file') as 'dir' | 'file' }));
    return sortEntries(mapped);
  } catch {
    return [];
  }
}

export async function readFile(absPath: string, cap = MAX_BYTES): Promise<FileContentDTO> {
  const language = langFromPath(absPath);
  try {
    const stat = await fs.promises.stat(absPath);
    const buf = await fs.promises.readFile(absPath);
    if (isBinary(buf)) return { path: absPath, content: '', language, truncated: false, binary: true };
    const truncated = stat.size > cap;
    const content = (truncated ? buf.subarray(0, cap) : buf).toString('utf8');
    return { path: absPath, content, language, truncated, binary: false };
  } catch {
    return { path: absPath, content: '', language, truncated: false, binary: false };
  }
}

export async function readDiff(
  absPath: string,
  gitShow: (p: string) => Promise<string>,
): Promise<FileDiffDTO> {
  let work = '';
  let binary = false;
  try {
    const buf = await fs.promises.readFile(absPath);
    if (isBinary(buf)) binary = true;
    else work = buf.toString('utf8');
  } catch {
    /* file may be deleted in the working tree */
  }
  const head = await gitShow(absPath).catch(() => '');
  return { path: absPath, head: binary ? '' : head, work, binary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- fileService`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/fileService.ts test/unit/fileService.test.ts
git commit -m "feat: fileService readDir/readFile/readDiff + tests"
```

---

## Task 5: Host IPC handlers

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Add imports**

In `electron/main.ts`, add near the other `../src` imports:
```ts
import { readDir, readFile, readDiff } from '../src/fileService';
import { execFile } from 'child_process';
```

- [ ] **Step 2: Add a `gitShow` helper (module scope, below the path helpers)**

```ts
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout),
    );
  });
}

async function gitShow(absPath: string): Promise<string> {
  const dir = path.dirname(absPath);
  const root = (await git(['rev-parse', '--show-toplevel'], dir)).trim();
  if (!root) return '';
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  return git(['show', `HEAD:${rel}`], root);
}
```

- [ ] **Step 3: Add the message cases**

In the `handle` switch in `electron/main.ts`, after the `requestProject` case, add:
```ts
        case 'readDir':
          send({ type: 'dirEntries', path: m.path, entries: await readDir(m.path) });
          break;
        case 'readFile':
          send({ type: 'fileContent', doc: await readFile(m.path) });
          break;
        case 'readDiff':
          send({ type: 'fileDiff', doc: await readDiff(m.path, gitShow) });
          break;
```

- [ ] **Step 4: Verify build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts
git commit -m "feat: host handlers for readDir/readFile/readDiff"
```

---

## Task 6: Browser-preview mocks

**Files:**
- Modify: `webview/mock.ts`
- Modify: `webview/bridge.ts`

- [ ] **Step 1: Add mock data**

Append to `webview/mock.ts`:
```ts
import type { DirEntryDTO } from '../src/protocol';

export const mockDir: DirEntryDTO[] = [
  { name: 'src', kind: 'dir' },
  { name: 'README.md', kind: 'file' },
  { name: 'package.json', kind: 'file' },
];

export const mockFileText = `export function hello(name: string) {\n  return \`hi \${name}\`;\n}\n`;
export const mockMarkdown = `# Title\n\nSome **bold** text and a list:\n\n- one\n- two\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`;
```

- [ ] **Step 2: Handle the new requests in the bridge mock**

In `webview/bridge.ts`, add imports:
```ts
import { mockDir, mockFileText, mockMarkdown } from './mock';
```
Then in `mockHost`, before the `term:start` block, add:
```ts
  if (msg.type === 'readDir') {
    setTimeout(() => emit({ type: 'dirEntries', path: msg.path, entries: mockDir }), 15);
    return;
  }
  if (msg.type === 'readFile') {
    const isMd = msg.path.endsWith('.md');
    setTimeout(
      () => emit({
        type: 'fileContent',
        doc: { path: msg.path, content: isMd ? mockMarkdown : mockFileText, language: isMd ? 'markdown' : 'typescript', truncated: false, binary: false },
      }),
      15,
    );
    return;
  }
  if (msg.type === 'readDiff') {
    setTimeout(
      () => emit({ type: 'fileDiff', doc: { path: msg.path, head: 'const a = 1;\n', work: 'const a = 2;\n', binary: false } }),
      15,
    );
    return;
  }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add webview/mock.ts webview/bridge.ts
git commit -m "feat: preview mocks for readDir/readFile/readDiff"
```

---

## Task 7: Open-documents reducer (TDD)

**Files:**
- Create: `webview/docs.ts`
- Test: `test/unit/docs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/docs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { docsReducer, initialDocs, type DocsState } from '../../webview/docs';

const open = (s: DocsState, kind: 'file' | 'diff', path: string) =>
  docsReducer(s, { type: 'open', kind, path });

describe('docsReducer', () => {
  it('opens a document and makes it active', () => {
    const s = open(initialDocs, 'file', '/a.ts');
    expect(s.docs.map((d) => d.path)).toEqual(['/a.ts']);
    expect(s.activeId).toBe('file:/a.ts');
    expect(s.docs[0].title).toBe('a.ts');
  });

  it('dedupes by kind+path, re-activating the existing tab', () => {
    let s = open(initialDocs, 'file', '/a.ts');
    s = open(s, 'file', '/b.ts');
    s = open(s, 'file', '/a.ts');
    expect(s.docs).toHaveLength(2);
    expect(s.activeId).toBe('file:/a.ts');
  });

  it('treats file and diff of the same path as distinct tabs', () => {
    let s = open(initialDocs, 'file', '/a.ts');
    s = open(s, 'diff', '/a.ts');
    expect(s.docs).toHaveLength(2);
    expect(s.activeId).toBe('diff:/a.ts');
  });

  it('closing the active doc activates the previous, or terminal when none', () => {
    let s = open(initialDocs, 'file', '/a.ts');
    s = open(s, 'file', '/b.ts');
    s = docsReducer(s, { type: 'close', id: 'file:/b.ts' });
    expect(s.activeId).toBe('file:/a.ts');
    s = docsReducer(s, { type: 'close', id: 'file:/a.ts' });
    expect(s.docs).toHaveLength(0);
    expect(s.activeId).toBeNull(); // terminal
  });

  it('activate(null) selects the terminal', () => {
    let s = open(initialDocs, 'file', '/a.ts');
    s = docsReducer(s, { type: 'activate', id: null });
    expect(s.activeId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- docs`
Expected: FAIL (`webview/docs` not found).

- [ ] **Step 3: Implement the reducer**

Create `webview/docs.ts`:
```ts
export type DocKind = 'file' | 'diff';

export interface OpenDoc {
  id: string; // `${kind}:${path}`
  kind: DocKind;
  path: string;
  title: string;
}

export interface DocsState {
  docs: OpenDoc[];
  activeId: string | null; // null = the Terminal tab
}

export type DocsAction =
  | { type: 'open'; kind: DocKind; path: string }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string | null };

export const initialDocs: DocsState = { docs: [], activeId: null };

const idOf = (kind: DocKind, path: string) => `${kind}:${path}`;
const titleOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

export function docsReducer(state: DocsState, action: DocsAction): DocsState {
  switch (action.type) {
    case 'open': {
      const id = idOf(action.kind, action.path);
      if (state.docs.some((d) => d.id === id)) return { ...state, activeId: id };
      const doc: OpenDoc = { id, kind: action.kind, path: action.path, title: titleOf(action.path) };
      return { docs: [...state.docs, doc], activeId: id };
    }
    case 'close': {
      const idx = state.docs.findIndex((d) => d.id === action.id);
      if (idx === -1) return state;
      const docs = state.docs.filter((d) => d.id !== action.id);
      let activeId = state.activeId;
      if (state.activeId === action.id) {
        const next = docs[idx - 1] ?? docs[idx] ?? null;
        activeId = next ? next.id : null;
      }
      return { docs, activeId };
    }
    case 'activate':
      return { ...state, activeId: action.id };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- docs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add webview/docs.ts test/unit/docs.test.ts
git commit -m "feat: open-documents reducer + tests"
```

---

## Task 8: Monaco dark theme + CodeViewer

**Files:**
- Create: `webview/monaco-theme.ts`
- Create: `webview/components/CodeViewer.tsx`

- [ ] **Step 1: Define the theme**

Create `webview/monaco-theme.ts`:
```ts
import * as monaco from 'monaco-editor';

let defined = false;

/** Register a dark theme matching the app palette. Idempotent. */
export function ensureTheme(): string {
  if (!defined) {
    monaco.editor.defineTheme('agentdeck', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '585e6a', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'd9775c' },
        { token: 'string', foreground: '6cc18a' },
        { token: 'number', foreground: 'd9a14b' },
        { token: 'type', foreground: '5e9bd6' },
      ],
      colors: {
        'editor.background': '#0a0b0e',
        'editor.foreground': '#d7dae1',
        'editorLineNumber.foreground': '#3a3f49',
        'editor.selectionBackground': '#d9775c33',
        'editorCursor.foreground': '#d9775c',
        'editorGutter.background': '#0a0b0e',
        'diffEditor.insertedTextBackground': '#6cc18a22',
        'diffEditor.removedTextBackground': '#e0726f22',
      },
    });
    defined = true;
  }
  return 'agentdeck';
}
```

- [ ] **Step 2: Implement CodeViewer**

Create `webview/components/CodeViewer.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { FileContentDTO } from '../../src/protocol';
import { ensureTheme } from '../monaco-theme';

export function CodeViewer({ doc }: { doc: FileContentDTO }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const theme = ensureTheme();
    const editor = monaco.editor.create(ref.current, {
      value: doc.binary ? '' : doc.content,
      language: doc.language,
      theme,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    return () => editor.dispose();
  }, [doc.path, doc.content]);

  if (doc.binary) return <div className="viewer__notice">Binary file — no preview.</div>;
  return (
    <div className="viewer">
      {doc.truncated && <div className="viewer__banner">Large file — showing the first 2 MB.</div>}
      <div className="viewer__monaco" ref={ref} />
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS (Monaco bundles into `out/webview.js`).

- [ ] **Step 4: Commit**

```bash
git add webview/monaco-theme.ts webview/components/CodeViewer.tsx
git commit -m "feat: Monaco dark theme + read-only CodeViewer"
```

---

## Task 9: MarkdownViewer

**Files:**
- Create: `webview/components/MarkdownViewer.tsx`

- [ ] **Step 1: Implement the component**

Create `webview/components/MarkdownViewer.tsx`:
```tsx
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { FileContentDTO } from '../../src/protocol';
import { CodeViewer } from './CodeViewer';

export function MarkdownViewer({ doc }: { doc: FileContentDTO }) {
  const [source, setSource] = useState(false);

  if (source) {
    return (
      <div className="viewer">
        <button className="viewer__toggle" onClick={() => setSource(false)}>View rendered</button>
        <CodeViewer doc={doc} />
      </div>
    );
  }

  return (
    <div className="viewer">
      <button className="viewer__toggle" onClick={() => setSource(true)}>View source</button>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {doc.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add webview/components/MarkdownViewer.tsx
git commit -m "feat: rendered MarkdownViewer with view-source toggle"
```

---

## Task 10: DiffViewer

**Files:**
- Create: `webview/components/DiffViewer.tsx`

- [ ] **Step 1: Implement the component**

Create `webview/components/DiffViewer.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { FileDiffDTO } from '../../src/protocol';
import { langFromPath } from '../../src/fileService';
import { ensureTheme } from '../monaco-theme';

export function DiffViewer({ doc }: { doc: FileDiffDTO }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || doc.binary) return;
    const theme = ensureTheme();
    const language = langFromPath(doc.path);
    const editor = monaco.editor.createDiffEditor(ref.current, {
      theme,
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
    });
    editor.setModel({
      original: monaco.editor.createModel(doc.head, language),
      modified: monaco.editor.createModel(doc.work, language),
    });
    return () => {
      const m = editor.getModel();
      m?.original.dispose();
      m?.modified.dispose();
      editor.dispose();
    };
  }, [doc.path, doc.head, doc.work]);

  if (doc.binary) return <div className="viewer__notice">Binary file — no diff preview.</div>;
  return <div className="viewer"><div className="viewer__monaco" ref={ref} /></div>;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add webview/components/DiffViewer.tsx
git commit -m "feat: Monaco DiffViewer (HEAD vs working)"
```

---

## Task 11: DocView dispatcher

**Files:**
- Create: `webview/components/DocView.tsx`

- [ ] **Step 1: Implement the dispatcher**

Create `webview/components/DocView.tsx`:
```tsx
import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../docs';
import { CodeViewer } from './CodeViewer';
import { MarkdownViewer } from './MarkdownViewer';
import { DiffViewer } from './DiffViewer';

export function DocView({
  doc,
  file,
  diff,
}: {
  doc: OpenDoc;
  file?: FileContentDTO;
  diff?: FileDiffDTO;
}) {
  if (doc.kind === 'diff') {
    if (!diff) return <div className="viewer__notice">Loading diff…</div>;
    return <DiffViewer doc={diff} />;
  }
  if (!file) return <div className="viewer__notice">Loading…</div>;
  if (file.language === 'markdown') return <MarkdownViewer doc={file} />;
  return <CodeViewer doc={file} />;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add webview/components/DocView.tsx
git commit -m "feat: DocView viewer dispatcher"
```

---

## Task 12: DocTabs + CenterPane integration

**Files:**
- Create: `webview/components/DocTabs.tsx`
- Modify: `webview/components/CenterPane.tsx`

- [ ] **Step 1: Implement DocTabs**

Create `webview/components/DocTabs.tsx`:
```tsx
import type { OpenDoc } from '../docs';
import { IconSparkle, IconClose, IconBranch } from '../icons';

export function DocTabs({
  docs,
  activeId,
  terminalLabel,
  onSelect,
  onClose,
}: {
  docs: OpenDoc[];
  activeId: string | null;
  terminalLabel: string;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="tabbar">
      <button
        className={`tab ${activeId === null ? 'tab--active' : ''}`}
        onClick={() => onSelect(null)}
      >
        <IconSparkle size={13} className="tab__spark" />
        <span>{terminalLabel}</span>
      </button>
      {docs.map((d) => (
        <button
          key={d.id}
          className={`tab ${activeId === d.id ? 'tab--active' : ''}`}
          onClick={() => onSelect(d.id)}
        >
          {d.kind === 'diff' && <IconBranch size={12} className="tab__spark" />}
          <span>{d.title}</span>
          <span
            className="tab__close"
            title="Close"
            onClick={(e) => { e.stopPropagation(); onClose(d.id); }}
          >
            <IconClose size={12} />
          </span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite CenterPane to host tabs + active content**

Replace `webview/components/CenterPane.tsx` with:
```tsx
import type { AgentDefinition, Session } from '../../src/types';
import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../docs';
import { TerminalPane } from './TerminalPane';
import { DocTabs } from './DocTabs';
import { DocView } from './DocView';

export function CenterPane({
  sessions,
  agents,
  activeId,
  docs,
  activeDocId,
  files,
  diffs,
  onSelectDoc,
  onCloseDoc,
  onRelaunch,
}: {
  sessions: Session[];
  agents: AgentDefinition[];
  activeId: string | undefined;
  docs: OpenDoc[];
  activeDocId: string | null;
  files: Map<string, FileContentDTO>;
  diffs: Map<string, FileDiffDTO>;
  onSelectDoc: (id: string | null) => void;
  onCloseDoc: (id: string) => void;
  onRelaunch: (id: string) => void;
}) {
  const active = sessions.find((s) => s.id === activeId);
  const labelFor = (agentId: string) => agents.find((a) => a.id === agentId)?.label ?? agentId;
  const running = sessions.filter((s) => s.status === 'running');
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? null;
  const showDoc = activeDoc !== null;

  return (
    <main className="center">
      <DocTabs
        docs={docs}
        activeId={activeDocId}
        terminalLabel={active?.name ?? 'Terminal'}
        onSelect={onSelectDoc}
        onClose={onCloseDoc}
      />

      <div className="termwrap">
        {/* Terminals stay mounted; hidden while a document tab is active. */}
        <div className="termstack" style={{ display: showDoc ? 'none' : 'block' }}>
          {sessions.length === 0 && (
            <div className="center-empty">
              <p>No active session.</p>
              <p className="center-empty__hint">Click <strong>New</strong> to start a terminal.</p>
            </div>
          )}
          {running.map((s) => (
            <div key={s.id} className="termhost" style={{ display: s.id === activeId ? 'block' : 'none' }}>
              <TerminalPane sessionId={s.id} agentId={s.agentId} cwd={s.projectPath} />
            </div>
          ))}
          {active && active.status === 'stale' && (
            <div className="stale">
              <p className="stale__title">Session not running</p>
              <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>↻ Relaunch</button>
            </div>
          )}
          {active && active.status === 'exited' && (
            <div className="stale">
              <p className="stale__title">Process exited</p>
              <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>↻ Restart</button>
            </div>
          )}
        </div>

        {showDoc && activeDoc && (
          <DocView
            doc={activeDoc}
            file={files.get(activeDoc.path)}
            diff={diffs.get(activeDoc.path)}
          />
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: FAIL typecheck later until App passes the new props — build (esbuild, no typecheck) should still succeed. Run `npm run build` to confirm bundling works; typecheck is wired in Task 13.

- [ ] **Step 4: Commit**

```bash
git add webview/components/DocTabs.tsx webview/components/CenterPane.tsx
git commit -m "feat: center tab strip (terminal + document tabs)"
```

---

## Task 13: App wiring + RightPane interactivity

**Files:**
- Modify: `webview/App.tsx`
- Modify: `webview/components/RightPane.tsx`

- [ ] **Step 1: Wire docs state + content caches in App**

In `webview/App.tsx`:

Add imports:
```tsx
import { useReducer } from 'react';
import { docsReducer, initialDocs } from './docs';
import type { FileContentDTO, FileDiffDTO } from '../src/protocol';
```

Inside `App`, after the existing `useState` hooks, add:
```tsx
  const [docState, dispatchDocs] = useReducer(docsReducer, initialDocs);
  const [files, setFiles] = useState<Map<string, FileContentDTO>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, FileDiffDTO>>(new Map());
```

In the `subscribe` effect callback, extend the message handling:
```tsx
      if (msg.type === 'state') setState(msg);
      else if (msg.type === 'project') setProject(msg);
      else if (msg.type === 'fileContent') setFiles((m) => new Map(m).set(msg.doc.path, msg.doc));
      else if (msg.type === 'fileDiff') setDiffs((m) => new Map(m).set(msg.doc.path, msg.doc));
```

Add open helpers (after `activeProject` is computed):
```tsx
  const openFile = (path: string) => {
    if (!files.has(path)) post({ type: 'readFile', path });
    dispatchDocs({ type: 'open', kind: 'file', path });
  };
  const openDiff = (path: string) => {
    post({ type: 'readDiff', path }); // always refresh a diff
    dispatchDocs({ type: 'open', kind: 'diff', path });
  };
```

- [ ] **Step 2: Pass the new props to CenterPane and RightPane**

Replace the `<CenterPane .../>` element with:
```tsx
      <CenterPane
        sessions={sessions}
        agents={agents}
        activeId={activeId}
        docs={docState.docs}
        activeDocId={docState.activeId}
        files={files}
        diffs={diffs}
        onSelectDoc={(id) => dispatchDocs({ type: 'activate', id })}
        onCloseDoc={(id) => dispatchDocs({ type: 'close', id })}
        onRelaunch={(id) => post({ type: 'relaunch', id })}
      />
```

Replace the `<RightPane .../>` element with:
```tsx
      <RightPane
        projectPath={active?.projectPath}
        changes={projectData?.changes ?? []}
        onOpenFile={openFile}
        onOpenDiff={(rel) => active?.projectPath && openDiff(joinPath(active.projectPath, rel))}
      />
```

Add a small path joiner near the top of `App.tsx` (after imports):
```tsx
const joinPath = (base: string, rel: string) =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.replace(/\\/g, '/');
```

- [ ] **Step 3: Rewrite RightPane with an interactive tree**

Replace `webview/components/RightPane.tsx` with:
```tsx
import { useEffect, useState } from 'react';
import type { ChangeDTO, DirEntryDTO } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import { IconSearch, IconFolder, IconChevron } from '../icons';

function ChangesView({
  changes,
  onOpenDiff,
}: {
  changes: ChangeDTO[];
  onOpenDiff: (relPath: string) => void;
}) {
  if (changes.length === 0) return <div className="right__empty">No changes</div>;
  const totalAdd = changes.reduce((a, c) => a + c.added, 0);
  const totalDel = changes.reduce((a, c) => a + c.removed, 0);
  return (
    <>
      <div className="right__actions">
        <button className="btn btn--primary">Stage Changes</button>
        <button className="btn">Stash</button>
        <button className="btn btn--ghost">Reset all</button>
      </div>
      <div className="changes__summary">
        <span>{changes.length} files</span>
        <span className="diffstat">
          <span className="diffstat--add">+{totalAdd}</span>{' '}
          <span className="diffstat--del">-{totalDel}</span>
        </span>
      </div>
      <div className="right__scroll">
        {changes.map((c) => {
          const parts = c.path.split('/');
          const file = parts.pop()!;
          const dir = parts.join('/');
          return (
            <div className="change" key={c.path} onClick={() => onOpenDiff(c.path)} title="Open diff">
              <span className={`change__kind change__kind--${c.kind}`}>{c.kind}</span>
              <span className="change__path">
                {dir && <span className="change__dir">{dir}/</span>}
                <span className="change__file">{file}</span>
              </span>
              <span className="change__stat">
                {c.added > 0 && <span className="diffstat--add">+{c.added}</span>}
                {c.removed > 0 && <span className="diffstat--del"> -{c.removed}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

interface TreeNode {
  name: string;
  path: string; // absolute
  kind: 'dir' | 'file';
  expanded: boolean;
  children?: TreeNode[];
}

function FilesView({
  projectPath,
  onOpenFile,
}: {
  projectPath: string | undefined;
  onOpenFile: (absPath: string) => void;
}) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const join = (base: string, name: string) => `${base.replace(/[\\/]+$/, '')}/${name}`;

  // Load the root listing when the project changes.
  useEffect(() => {
    setRoots([]);
    if (projectPath) post({ type: 'readDir', path: projectPath });
  }, [projectPath]);

  // Receive directory listings and graft them into the tree.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'dirEntries') return;
      const children: TreeNode[] = msg.entries.map((e: DirEntryDTO) => ({
        name: e.name,
        path: join(msg.path, e.name),
        kind: e.kind,
        expanded: false,
      }));
      if (projectPath && msg.path === projectPath) {
        setRoots(children);
        return;
      }
      setRoots((prev) => graft(prev, msg.path, children));
    });
  }, [projectPath]);

  const graft = (nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] =>
    nodes.map((n) => {
      if (n.path === path) return { ...n, expanded: true, children };
      if (n.children) return { ...n, children: graft(n.children, path, children) };
      return n;
    });

  const toggle = (node: TreeNode) => {
    if (node.kind === 'file') { onOpenFile(node.path); return; }
    if (node.expanded) {
      setRoots((prev) => collapse(prev, node.path));
    } else if (node.children) {
      setRoots((prev) => expand(prev, node.path));
    } else {
      setPending(node.path);
      post({ type: 'readDir', path: node.path });
    }
  };

  const expand = (nodes: TreeNode[], path: string): TreeNode[] =>
    nodes.map((n) =>
      n.path === path ? { ...n, expanded: true }
        : n.children ? { ...n, children: expand(n.children, path) } : n,
    );
  const collapse = (nodes: TreeNode[], path: string): TreeNode[] =>
    nodes.map((n) =>
      n.path === path ? { ...n, expanded: false }
        : n.children ? { ...n, children: collapse(n.children, path) } : n,
    );

  void pending;

  const rows: { node: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (n.kind === 'dir' && n.expanded && n.children) walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);

  if (!projectPath) return <div className="right__empty">No active project</div>;
  if (roots.length === 0) return <div className="right__empty">Empty or loading…</div>;

  return (
    <div className="right__scroll right__scroll--files">
      {rows.map(({ node, depth }) => (
        <div
          className="filerow"
          key={node.path}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => toggle(node)}
        >
          {node.kind === 'dir' ? (
            <IconChevron size={12} className={`filerow__chev ${node.expanded ? 'filerow__chev--open' : ''}`} />
          ) : (
            <span className="filerow__chev-spacer" />
          )}
          {node.kind === 'dir' && <IconFolder size={13} className="filerow__icon" />}
          <span className="filerow__name">{node.name}</span>
        </div>
      ))}
    </div>
  );
}

export function RightPane({
  projectPath,
  changes,
  onOpenFile,
  onOpenDiff,
}: {
  projectPath: string | undefined;
  changes: ChangeDTO[];
  onOpenFile: (absPath: string) => void;
  onOpenDiff: (relPath: string) => void;
}) {
  const [tab, setTab] = useState<'changes' | 'files'>('changes');
  return (
    <aside className="right">
      <div className="right__tabs">
        <button className={`rtab ${tab === 'changes' ? 'rtab--active' : ''}`} onClick={() => setTab('changes')}>
          Changes
        </button>
        <button className={`rtab ${tab === 'files' ? 'rtab--active' : ''}`} onClick={() => setTab('files')}>
          Files
        </button>
      </div>
      {tab === 'changes'
        ? <ChangesView changes={changes} onOpenDiff={onOpenDiff} />
        : <FilesView projectPath={projectPath} onOpenFile={onOpenFile} />}
    </aside>
  );
}
```

(Note: `IconSearch` import is retained for future search; remove if your lint flags unused — it does not under the current tsconfig.)

- [ ] **Step 4: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS. (`FileNodeDTO` is no longer used by RightPane; that's fine — it remains in protocol for `project` messages.)

- [ ] **Step 5: Run unit tests**

Run: `npm run test:unit`
Expected: PASS (fileService + docs + existing suites).

- [ ] **Step 6: Commit**

```bash
git add webview/App.tsx webview/components/RightPane.tsx
git commit -m "feat: wire docs state, interactive file tree, click-to-diff"
```

---

## Task 14: Viewer styles

**Files:**
- Modify: `webview/styles.css`

- [ ] **Step 1: Add styles for viewers, tabs, tree chevron, markdown**

Append to `webview/styles.css`:
```css
/* ---------- editor-area viewers ---------- */
.viewer { position: relative; height: 100%; display: flex; flex-direction: column; min-height: 0; }
.viewer__monaco { flex: 1; min-height: 0; }
.viewer__notice, .viewer__banner {
  padding: 10px 14px; color: var(--text-dim); font-size: 12.5px;
}
.viewer__banner { background: var(--raise); border-bottom: 1px solid var(--border); }
.viewer__toggle {
  position: absolute; top: 8px; right: 14px; z-index: 5;
  font: inherit; font-size: 11px; color: var(--text-dim);
  background: var(--raise); border: 1px solid var(--border-2); border-radius: var(--r-sm);
  padding: 3px 8px; cursor: pointer;
}
.viewer__toggle:hover { color: var(--text); border-color: var(--accent); }

.markdown { overflow: auto; padding: 22px 28px; max-width: 860px; line-height: 1.65; }
.markdown h1, .markdown h2, .markdown h3 { font-family: var(--font-display); letter-spacing: -0.01em; }
.markdown h1 { font-size: 26px; margin: 0 0 14px; }
.markdown h2 { font-size: 20px; margin: 26px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.markdown a { color: var(--accent-2); }
.markdown code { font-family: var(--font-mono); font-size: 12px; background: var(--raise); padding: 1px 5px; border-radius: 4px; }
.markdown pre { background: #0a0b0e; border: 1px solid var(--border); border-radius: var(--r-sm); padding: 12px 14px; overflow: auto; }
.markdown pre code { background: none; padding: 0; }
.markdown blockquote { border-left: 3px solid var(--accent); margin: 0; padding-left: 14px; color: var(--text-dim); }

/* document tab close + tree chevron rotation */
.tab__close { display: inline-grid; place-items: center; margin-left: 4px; color: var(--text-faint); border-radius: 4px; }
.tab__close:hover { color: var(--text); background: var(--raise); }
.filerow { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; border-radius: var(--r-sm); }
.filerow:hover { background: var(--raise); }
.filerow__chev { color: var(--text-faint); transition: transform .1s; flex: 0 0 auto; }
.filerow__chev--open { transform: rotate(90deg); }
.filerow__chev-spacer { width: 12px; flex: 0 0 auto; }
.filerow__icon { color: var(--text-dim); flex: 0 0 auto; }
.filerow__name { font-size: 12.5px; }
.termstack { height: 100%; }
```

- [ ] **Step 2: Verify build + screenshot the preview**

Run:
```bash
npm run build
node tools/render-webview.mjs
node tools/preview-server.mjs 5183
```
Then with playwright-cli: open `http://127.0.0.1:5183/preview.html`, switch the right panel to **Files**, click a file, and screenshot to `%TEMP%\claude-scratch\viewer.png`. Expected: a Monaco editor (or rendered markdown for `README.md`) fills the center; clicking a Changes row shows a side-by-side diff. Stop the server when done.

- [ ] **Step 3: Commit**

```bash
git add webview/styles.css
git commit -m "style: viewers, document tabs, file tree, markdown"
```

---

## Task 15: End-to-end verification in the app

**Files:** none (verification only)

- [ ] **Step 1: Full check**

Run: `npm run build && npm run typecheck && npm run test:unit`
Expected: all PASS.

- [ ] **Step 2: Launch + verify via CDP**

Launch the app with `--remote-debugging-port=9222`, attach playwright-cli via `attach --cdp=http://localhost:9222`, then: open a session, switch the right panel to **Files**, expand a folder (lazy load), open a `.ts` file (Monaco highlighted), open a `.md` file (rendered + view-source toggle), and click a row under **Changes** (side-by-side diff). Screenshot each to `%TEMP%\claude-scratch\`. Detach when done.

Expected: tree expands on demand; files open as center tabs; terminal tab still switches back to a live terminal; diff renders.

- [ ] **Step 3: Final commit (if any tweaks)**

```bash
git add -A -- . ':!.cursor'
git commit -m "test: verify file browser + viewer end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** interactive lazy tree (Task 13), Monaco read-only viewer (Task 8), markdown render + source toggle (Task 9), click-to-diff (Tasks 10/13), center tabs with terminal kept mounted (Task 12), IPC + fileService (Tasks 2/3/4/5), Monaco local bundling + editor worker + CSP (Task 1), dark theme (Task 8), error/edge handling — binary/truncated/missing (Tasks 4/8/10), tests (Tasks 3/4/7). Deferred items (editing, go-to-def, fuzzy search) intentionally absent.
- **Types:** `OpenDoc`/`DocsState`/`DocsAction` (Task 7) are consumed unchanged in Tasks 11–13; `FileContentDTO`/`FileDiffDTO`/`DirEntryDTO` (Task 2) used consistently in host (5), mocks (6), and viewers (8–13).
- **Editing-later seam:** `readFile`/`fileContent` mirror a future `writeFile`; `App` already caches file content by path.
