---
status: building (CON-63)
date: 2026-11-18
ticket: CON-63
---

# Release tree proof

A version bump changes runtime inputs. Release notes come from CHANGELOG.md, and the packaged version comes from package.json. Prepare the release commit before testing so the full suite sees the same tree the tag will ship.

## Prepare and tag

1. On a clean checkout of the intended release source, put the notes under Unreleased in CHANGELOG.md. An already-authored next-version section is also accepted when Unreleased is empty.
2. Run `npm run release -- patch` or `npm run release -- minor`. This creates `release/v<version>` and commits the dated notes, README status version, package version and lockfile. The existing major and minor script aliases prepare branches through the same path. The no-argument command prepares a patch.
3. Run `npm run e2e:remote -- --full` on the prepared tree.
4. Run `npm run release -- tag` on the clean prepared branch. This creates a local annotated tag after finding clean full-suite proof for its tree. Push the tag through the normal release process when ready.

If notes or version metadata are inconsistent, preparation stops before switching branches. If the branch or tag already exists, Git refuses to replace it. After a failed commit hook, resolve the error and finish the prepared commit on the release branch before testing. If a later merge changes the tree, test that new tree before tagging.

## Evidence and fallback

A full e2e dispatch or scheduled run can upload an immutable GitHub Actions artifact named `e2e-full-<tree>` for 90 days. The report step produces it after its verdict, only on the first workflow attempt and only when the full result passed with at least one scenario pass, zero failures, and zero retries. Platform skips and declared exclusions keep their existing meaning. A QUARANTINED-FAIL prevents proof, including scrollback-inrun until it passes.

Both the release tool and Release workflow verify the artifact against GitHub run metadata. The run must come from this repository’s `.github/workflows/e2e.yml`, conclude successfully on its first attempt, and report a full selection with the run ID and tested commit SHA. GitHub’s tested tree must equal the candidate tree. The workflow file is part of that tree, so equality also binds its definition. A different commit with the same tree qualifies. Evidence from a different tree, workflow, repo, partial run, or unsuccessful or retried run does not qualify.

Release validates its notes and runs the existing verify gate. It skips its full e2e only on affirmative proof. Missing, expired or unreadable evidence runs the full suite on the tag with the existing verdict rules. Publishing requires verify success and either a successful full e2e call or a successful proof check that explicitly skipped the call. Installer builds and publishing follow the same path in both cases.

Scheduled nightly reuse has a separate state requirement and accepts only scheduled proof on main. See the [remote e2e spec](archive/2026-09-29-remote-e2e-lean-loop.md).
