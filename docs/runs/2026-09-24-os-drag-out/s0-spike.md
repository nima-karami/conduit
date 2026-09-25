# os-drag-out S0 spike: measurements (2026-09-24)

Plan: `docs/plans/2026-09-24-os-drag-out.plan.md` Slice 0. Machine: Windows 11 Pro 22621, one
5120×1440 display, Electron from the repo's `node_modules`. Everything ran from
`%TEMP%\claude-scratch\os-drag-out\s0\` (deleted afterwards).

## Results

| Finding | Result | Evidence |
|---|---|---|
| F1: native `startDrag` → Explorer copies all 4 items, originals intact | **UNMEASURED** | The real-input driver (`drive-input.ps1`, `user32!SendInput`) was refused by the session's permission system before it was written, so no OS drag could be started. The spike app (`main.cjs` / `preload.cjs` / `index.html` per Task 0.1) was built but never driven. |
| F2: in-window drop, `getPathForFile` originals, `started` before drop, `rt` < 1000 ms mid-drag, ticks queued, pointer events | **UNMEASURED** | Same: needs a real OS drag. |
| F3: Ctrl held → `ctrlKey === true` on drop | **UNMEASURED** | Same. |
| F4: `SET_CLIPBOARD_SCRIPT` via PowerShell 5.1 → Explorer paste | **PASS** | See below. |
| F5: `will-download` fires for a `DownloadURL` drag, and `preventDefault` stops the file | **UNMEASURED** | Same: needs a real OS drag. |
| F6: macOS Finder same-volume drop is a copy | **UNMEASURED** | No macOS here (planned). |

UNMEASURED counts as FAIL (plan, branch table).

### F4 evidence

The probe bundled the real `electron/os-file-clipboard.ts` `spawnPowerShell` and
`src/os-clipboard-payload.ts` `buildPowerShellClipboardSpawn` with esbuild, so the exact committed
script and spawn ran (absolute `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
`-Sta -NoProfile -NonInteractive -Command <SET_CLIPBOARD_SCRIPT>`, paths on stdin as base64 of
UTF-8 JSON, `shell:false`).

- Paths: `s0\src\one.txt`, `s0\src\dir` (containing `inner.txt`), `s0\src\ünï 日本.txt`.
- Runner result: `{"ok":true}`.
- `Get-Clipboard -Format FileDropList` listed the 3 paths, the non-ASCII name intact.
- `Shell.Application.NameSpace(dst4).Self.InvokeVerb('Paste')` produced
  `dir/ | one.txt | ünï 日本.txt` in `dst4`, with `dir\inner.txt` present. Both files' SHA-256
  hashes matched their sources, and `src` still held all 4 items.
- The prior text clipboard was saved with `Get-Clipboard -Raw` and restored with `Set-Clipboard`;
  a read-back matched. Non-text clipboard formats (if any) were not preserved, as planned.
- Side observation: `Set-Clipboard -LiteralPath` accepts paths that don't exist (a first probe run
  with mangled paths still exited 0). Existence is only ever checked by the host validator
  (`missing`), which runs before the spawn.

### F4 re-measure: mixed separators (after review B2)

Tree rows join names with `/` on every platform, so the renderer sends `C:\proj/sub/a.txt` (a
picker-opened home) or `C:/proj/a.txt` (a forward-slash home). A fresh probe bundled the shipped
`validateOutgoingPaths` + `buildPowerShellClipboardSpawn` + `spawnPowerShell`, with this input:
`…\s0f4/src/one.txt`, `C:/…/s0f4/src/dir`, `…\s0f4/src/ünï 日本.txt`.

| Run | stdin paths | `FileDropList` | Explorer paste |
|---|---|---|---|
| raw (validator skipped, information only) | mixed, as sent | native backslashes | **PASS**: 3 items, `dir\inner.txt`, bytes equal |
| validated (the shipped path) | native backslashes (`path.resolve`) | native backslashes | **PASS**: same |

`Set-Clipboard -LiteralPath` resolves separators itself, so Explorer paste would have worked even
without the fix. The host still normalises once after validation, because a native drag
(`startDrag`, Slice 3) gets no such help. The text clipboard was saved and restored (read-back
matched). **F4 stays PASS.**

## Chosen outcome

**C** (not A, since F1–F3 are unmeasured; F5 unmeasured → FAIL):

- `DRAG_OUT_MODE`: not created. `DOWNLOAD_URL_GATED`: not created.
- Windows clipboard: F4 PASS → `osFileClipboardSupported('win32') === true`.
- Slices built: 0, 1, 2, 7. Folder and multi-file drag-out are **deferred**; no file drags out of
  the tree in this build.

**[high] for the user:** outcome C comes from the measurement being blocked, not failed. Re-running
F1, F2, F3 and F5 with the real-input driver allowed (it takes the mouse and focus for about a
minute) can move this to A, A′ or B, which builds Slices 3–6.
