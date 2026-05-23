# Research

Bessemer's versioned research artifacts. Captures what each release of `agent-dev-team` is meaningfully advancing — not just what it ships.

## Why this exists

We want every meaningful version to demonstrably contribute to the agent-dev space, not just iterate on features. Each major version carries an overall thesis; each minor version carries a specific research question; each question has a documented answer at version close.

## Structure

- `epochs/` — one whitepaper per major version (`v1.md`, `v2.md`...). Living document: drafted at epoch open, refined as cycles land, locked at epoch close.
- `cycles/` — one folder per minor version (`v1.6/`, `v1.7/`...). Each contains:
  - `scope.md` — the research question and why it matters now. Locks before build begins.
  - `experiment-log.md` — what was tried during the cycle, continuous.
  - `findings.md` — what was learned, written at cycle close.
  - `next-questions.md` — questions surfaced that feed the next cycle's scope.

Sprints execute inside cycles against GitHub Issues. Patch versions emerge from sprints and roll up into the parent cycle's `experiment-log.md`.

## Three-layer cadence

| Layer | Maps to | Artifact |
|---|---|---|
| Epoch | Major version (`v1`, `v2`) | Whitepaper |
| Cycle | Minor version (`v1.6`, `v1.7`) | The four-file cycle folder |
| Sprint | Batch of GitHub Issues | Patch versions + log entries |
