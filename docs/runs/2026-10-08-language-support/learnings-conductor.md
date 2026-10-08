- [autonomous-build-loop] Integrate lanes by the REVIEWED SHA, never the branch name: a builder in a harness
  worktree committed on a detached HEAD, so `lane-a-language` stayed one review round behind and the merged
  QA tree lacked db31d3e — QA "failed" on an already-fixed defect. Assert `merge-base --is-ancestor <sha>`.
- [code-review] An "is it dirty on open" behaviour fixed only under a fake model needs an e2e assertion on the
  real tab state; AC-A5 checked banner + bytes but not `.tab__dirty`.
- [instruction-file] PowerShell 5.1 read-modify-write double-encodes UTF-8 (mojibake in comments) and no gate
  catches it; both lanes hit it. Builders must use the Edit tool for file edits.
