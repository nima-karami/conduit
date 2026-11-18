# CON-57 learnings (tagged for routing)

- [feature-spec] A source-read "current behavior" row marked ASSUMED let the reviewer disprove the persisted-doc edge case in one grep (`webview/docs.ts:973`, `src/persistence.ts:171`); measuring it first would have removed a bogus acceptance criterion.
- [implementation-plan] Parallel groups were first drawn across files that one group consumed from the other (summary module, McpSection → PermissionsRoles); the self-review caught it. A "Consumes" line must be checked against the other group's `Produces` before a plan calls two groups disjoint.
- [implementation-plan] The plan's focus-restore snippet fired on app mount (`settingsOpen` starts false). Effects keyed on a boolean that starts false need an "armed" guard; the executor found it, the plan should have.
- [build-and-verify] A plan step "focus X on mount" can overwrite a child's own focus (release-notes open path); the executor caught it only because existing focus tests covered it.
- [instruction-file] `npm run e2e:remote` pushes a temporary ref to origin; the agent brief for any build under a "no push" rule must say whether that counts.
