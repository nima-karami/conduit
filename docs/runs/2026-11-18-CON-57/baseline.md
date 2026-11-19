# CON-57 baseline (taken before any code change)

- Base: `main@ce1d7e87` (v0.69.0). Branch `CON-57-mcp-full-screen` carries only `docs/` commits on top (`git diff --stat ce1d7e87 HEAD -- . ':!docs'` is empty).
- Gate at base: `flock /tmp/claude-1000/conduit-gate.lock npm run verify` → **exit 0** (2026-11-18, nothing else running). Log: `/tmp/claude-1000/con57/baseline-verify.log`.
- Gate definitions: the base commit is the artifact. The anti-gaming diff is `git diff ce1d7e87 -- biome.json .fallowrc.json package.json vitest.config.* tools test` read for removed or narrowed checks; new tests are fine. Any existing assertion changed must keep its strength (lead requirement).
- Failure set at base: none.
