# Model tiers

The rule (stated in SKILL.md, restated here for the mapping): the session holds
decisions. Judgment-heavy delegated work runs one tier below the session; mechanical
work two tiers below, with a floor at the mid tier; never delegate upward. The bottom
tier never builds against slow or flaky suites and never writes a root-cause diagnosis.

| Tier | Models | Use |
|---|---|---|
| top | Fable | session/conductor judgment only; never product code, never content generation |
| high | Opus | judgment work: specs, plans, reviews, builders on real suites |
| mid | Sonnet | mechanical: transcript reading, file moves, fixtures, desk/dispatch sessions |
| low | Haiku | bulk classification only |

## Field evidence

- A mid-tier builder spun ~30 minutes stuck on an end-to-end suite; mid tier was banned
  as a builder from then on.
- Mid-tier spec writers produced confidently wrong root causes that the builder later
  had to disprove by measurement.
- The top tier was mis-used once for a 126-word content task — judgment only, never
  generation.

## Applying it in a run

- The conductor tier is whatever the session started on. Fix it in `goal.md` at kickoff
  and never auto-escalate to a "strongest available" tier mid-run — that silently jumps
  cost the user never chose.
- Executors run at or below the conductor's tier, never above.
- Record the tier used per item in the ledger entry alongside the topology, so a resume
  reads the decision instead of re-deriving it.
