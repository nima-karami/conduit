# F5 — Context menus depth

## Goal
Consistent, full right-click menus across every interactive surface, not just
sessions and tabs. Add file-tree and changes menus; enrich the existing ones.

## Menus
- **Session card** (existing + add): Reveal in Explorer, Duplicate, Copy path,
  Copy name, Rename, Relaunch (when not running), Close.
- **Document tab** (existing + add): Close, Close others, Close all, Copy path,
  Copy file name, Reveal in Explorer.
- **File tree row** (new): Open (files), Reveal in Explorer, Copy path,
  Copy relative path.
- **Changes row** (new): Open diff, Open file, Reveal in Explorer, Copy path.

## Wiring
- `RightPane` gains `onFileContextMenu(e, { path, kind })` and
  `onChangeContextMenu(e, relPath)`, threaded to filerow / change rows.
- App builds each menu (it owns post / clipboard / openFile / openDiff). Change
  rows resolve abs path via `joinPath(activeProjectPath, rel)`.
- All reuse the existing `ContextMenu` + `setMenu`.

## Acceptance criteria
1. Right-click a file row → menu with Open / Reveal / Copy path / Copy relative path; Open opens it.
2. Right-click a changes row → Open diff / Open file / Reveal / Copy path; actions work.
3. Tab menu has Close all + Copy file name; session menu has Copy name + Relaunch(when stale).
4. Menus dismiss consistently; reveal/copy wired to host/clipboard.
5. typecheck + build + tests green.
