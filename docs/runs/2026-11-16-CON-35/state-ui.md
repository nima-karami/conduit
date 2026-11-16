# UI orchestrator state (claude-25) — 2026-11-16 ~20:05Z

## Done (merged to CON-35-remote-ssh)
- CON-41, CON-47 (earlier).
- CON-43: 732255e8, verify 0, e2e:remote 43928939781.
- CON-44 + CON-45: 3889ae2f (from CON-35-ui 19d78c25), verify 0 (both sides), e2e:remote 43941753430 (285 PASS).
  - Link minors: fs.write 7, routed attach_folder 8. attach_folder's default reach is `opened` (lead decision).
  - CON-45 G1 passed a 4-round security re-review; accepted residuals are in docs/plans/2026-11-16-remote-ssh-git.plan.md.

## On CON-35-ui after the merge (goes with the next merge)
- 6e354303: quit/close dialogs save remote tabs (allSaves); local folder deletion skips remote docs.

## Follow-ups
- CON-42-ui (answer UI for mirrored remote asks + machine names on request cards): asked lead whether to take it next.
- The quit dialog shows a remote file's folder as its raw doc id.
- A dirty remote buffer when its owning remote session closes (sessionDirtyPaths covers only local files).
- Owner items: blockers.md.
