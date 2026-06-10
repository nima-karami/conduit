# U2 — Cross-file go-to-definition

## Problem
T5 enabled go-to-def only within the open file (only that model exists). Resolving
across files needs the other source files present as Monaco models, the TS service
configured for module resolution, and an editor opener so a definition in another
file actually navigates there.

## Host
- `indexProject {root}` → walk the project, pick source files (ts/tsx/js/jsx/mjs/cjs/
  mts/cts), read them (cap ~400, skip binary), and send
  `projectFiles {root, files:[{path, content, language}]}`.

## monacoSetup
- Set TS+JS compiler options: allowJs, jsx React, moduleResolution NodeJs, module
  ESNext, esModuleInterop, allowNonTsExtensions, target ES2020.
- `setEagerModelSync(true)` so the worker indexes every model.

## webview/projectIndex.ts
- `fileUri(path)` — canonical `file:///<abs>` URI (used by CodeViewer too, so the
  opened file and the background model are the same model).
- `indexModels(files)` — create a Monaco model per file if absent.
- A reveal map: `setReveal(path,pos)` / `takeReveal(path)` so a navigated file scrolls
  to the definition.

## App
- On opening a code file, if the active project isn't indexed yet, `indexProject(root)`
  (once per root). On `projectFiles`, `indexModels`.
- Register `monaco.editor.registerEditorOpener`: when Monaco wants to open a resource
  (cross-file definition), convert to abs path, `setReveal`, `openFile(abs)`, return true.
- CodeViewer uses `fileUri` and, on mount, applies any pending reveal (line/col).

## Acceptance criteria
1. Opening a TS file indexes the project's source files as models.
2. Go-to-definition on a symbol imported from another file resolves to that file
   (verified via the TS worker returning a definition whose fileName is the other file).
3. Triggering it navigates: the other file opens as a doc tab and reveals the line.
4. typecheck + build + tests green.
