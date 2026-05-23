# v1.6 — Findings

**Status:** Lightbackfill 2026-05-23.

## What was learned

- The scope-execute-approve loop works reliably for well-scoped hygiene issues. Every v1.6 issue closed in one or two review cycles with no rework beyond the reviewer's own feedback — no ambiguity spirals, no scope creep.
- Unit tests don't validate agentic-loop correctness. Three separate bugs (parallel `tool_use` handling in PR #192, draft-PR logic in PR #203, pipeline draft guard in PR #204) were only discoverable via end-to-end runs. The test suite passed green throughout; the bugs only appeared when a real Coder interacted with a real Claude API response shape.
- The `beforeEach` / `afterEach` pairing for env-var cleanup matters when `setup.js` seeds global values. Omitting `beforeEach` while having only `afterEach` makes tests pass in isolation but fail when run in sequence — a subtle order-dependency that bit the PM model-default tests.
- Side effects from merging parallel branches on overlapping files are predictable and avoidable if merge order is stated explicitly in the issue. The #201/#203 rebase conflict (both modifying `commitAndPush` in coder.js) was avoidable had the sequencing been written into the issue descriptions up front.
- A lint error discovered at release time (PR #207) pointed to a gap in the development loop: CI should catch errors earlier in the cycle, not just at the milestone PR.

## What would I do differently

- Open the milestone PR (develop→main) at the start of the cycle and keep it as a draft; CI then flags lint errors continuously rather than at the last moment.
- Encode merge-order constraints in the issue text when two issues touch the same files. "Merge after #N" is enough — it removes the ambiguity that caused the coder.js rebase conflict.
- Add an e2e smoke test fixture (even a shallow one with a stubbed Claude response) alongside the unit suite so agentic-loop-level bugs surface before they reach a human reviewer.
