# Retro: 2026-11-12-linux-compat

Seeded by `nimbus run report` from the run record. The owner's retro session adds the rest.

## Learnings
- [[autonomous-build-loop]] Conductor used gates and board moves but never nimbus step start/end, so the report has 0 step attempts and 0 tokens; record steps per phase. (#246)
- [[instruction-file]] Conduit's full gate includes fallow dead-code; builders running only verify:quick shipped an unused export. Builder briefs must include npm run fallow:check. (#247)
- [[nimbus run report]] Report does not apply a conductor.rekey mapping: events before #102 still show old keys, so CON-1 rows mix the old e2e card with the parent ticket. (#245)

## What the record shows
- Failed gates: 5 · Blocked or parked cards: none · Reversed decisions: 0 · Budget overruns: 0

## What went well

## What went wrong

## Changes to make (each with an evidence ref: #seq or sha256:...)
