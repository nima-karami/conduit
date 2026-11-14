# CON-24 learnings

- [implementation-plan] Contract briefs that specify a "fallback" (`grantScopeFor` → `anywhere` when nothing to bind) get built faithfully and then flagged by review as consent-widening. When a contract has no value for a case, the plan must say "null / refuse", never a wider default.
- [build-and-verify] fallow counts test files as entry points, so pure lanes stay green on their own tests. A shared types file is safe when it rides inside its first consumer's merge, on a lane base branch that isn't merged by itself.
- [code-review] The engine lane needed four review rounds. Each round found a real, distinct, fail-open or fail-closed defect: profile vs. explicit deny, drive-root keys, override consumption, per-target grants. Policy engines deserve a pre-written truth table of multi-target × grant × override × deny cases in the plan; a Haiku lane won't derive those cases itself.
- [CLAUDE.md] `folderKey`/`normalizeRoot` folded a bare drive root (`C:`) differently from `C:/x`. Fixed at the source in CON-24; the same gap in `repo-rel.ts` `isUnderRoot` is CON-29.
- [none] Claude Code 2.1.325 supports `async: true` on command hooks. A blocking PostToolUse hook would add the hook client's ~60 ms spawn to every tool call, so async plus a transcript-based gap check is the shape for observed lanes.
