# Roadmap

This document captures where `agent-dev-team` is heading. The mission: **make agentic software development accessible to normal people, as real working software — not a toy.**

The v1.x milestones below are committed work, tracked as GitHub Issues. The v2.x section is directional — bets we may take once the v1.x foundations are solid.

---

## Shipped

### v1.0.0 — Foundations
First end-to-end pipeline: Director receives a brief on Discord, generates a spec, PM creates Issues, Coder workers open PRs, Tech Lead reviews and merges. All inside the `agent-dev-team` repo.

### v1.1.0 — Project repos + estimation memory
Each project gets its own GitHub repo (created by PM). Estimation history is written to a shared `bessemer-state` repo so it persists across projects. Approval timeouts made configurable.

### v1.2.0 — Specialized workers + per-project surfaces
- Per-project Discord channels — each project gets `#proj-{name}` with its own webhook, archived on close (#88)
- Researcher worker for `type:research` Issues (#90) — runs focused research, posts as Issue comment, no PR
- Writer worker for `type:docs` Issues (#91) — generates docs/READMEs through the same branch/PR flow as Coder
- Optional separate GitHub account for Tech Lead (#89) — unlocks formal `APPROVE` / `REQUEST_CHANGES` reviews

### v1.2.1 — Hygiene
- CI: run tests on every PR via GitHub Actions
- Consolidated `.env` parsing into a single module (`src/config.js`)
- Removed dead message-contract code
- Deleted legacy root directories (`managers/`, `workers/`, `orchestrator/`, `pipeline/`)
- Synced `README.md` and `ARCHITECTURE.md` with v1.2 reality

### v1.3.0 — Agents that actually act
- Tool-using agentic Coder loop (read_file / write_file / list_dir / exec / done) iterating until the model calls `done`
- Tech Lead pulls the PR branch, runs the project's tests in a workspace (host execution; no container isolation yet), and merges only on green
- Replaced `score >= 3` numeric merge gate with real verification signals (tests pass / fail / not-run)

### v1.4.0 — A Director that actually directs
- Multi-turn spec refinement — Director posts a draft to `#director`, executive refines in plain language, `confirm` sends to `#approvals` (#113)
- Tech-stack-aware spec generation — LLM generates the full spec (projectType, architecture, techStack, deliverables); Python/Go briefs produce Python/Go specs; validated against `src/contracts/spec.schema.json` with retry (#114)
- Real estimation — PM uses historical mean from bessemer-state when ≥ 3 past projects match `projectType`; cold-start LLM fallback with honest confidence flags; `projectType` written to history on close (#115)

### v1.5.0 — Persistence + real concurrency
- SQLite persistence for `activeProjects` via `better-sqlite3` — DAL at `src/state/db.js`, single numbered migration, `:memory:` tests (#116)
- Crash recovery via `Pipeline.resume()` — loads open projects from SQLite, pre-populates `spawnedIssues` from open GitHub PRs (no double-spawning), re-instantiates agents and restarts watchers, posts recovery summary to `#director` (#117)
- GitHub webhook receiver — Express server at `src/webhooks/github.js`, HMAC-SHA256 signature verification, PM registers webhook on repo creation; pollers kept as 5-min safety net (#118)
- Project-scoped approval syntax — `waitForApproval` accepts `approve: {project-name}` and `reject: {project-name}` for unambiguous multi-project gate resolution; Director and PM show the scoped form in approval messages (#119 Option A)

---

## v1.x — Making it real software

The v1.x line closes the gap between **what the docs claim** and **what the code does**, then hardens the system for real-world use.

### v1.6.0 — Truth in advertising ✓ (current)
- Reconcile ROADMAP, README, and ARCHITECTURE with what is actually shipped — no false claims in any "Shipped" section
- Rename `Sandbox` → `Workspace` throughout; add explicit host-execution warnings so contributors understand the trust model
- Add `npm run lint` and fix ESLint config; add lint + audit steps to CI
- Hygiene: remove dead code, fix package.json metadata, remove stale docs

### v1.7.0 — Architecture cleanup
- Extract `src/llm/client.js` — single `chat()` entry point routing to Claude SDK or Ollama; eliminates per-agent branching on `ANTHROPIC_API_KEY`
- Migrate Coder's `callClaude` from raw `fetch` to the Anthropic SDK
- Implement real Ollama tool-use via the chat API's `tools` parameter (replace regex-parse hack)
- Refactor `escalate()` to post via webhook instead of spinning up a Director bot client

### v1.8.0 — Real Docker sandbox
- Container isolation for Coder and Tech Lead: pinned image, network isolation, resource limits, hard timeouts
- Project repo checked out inside the container; workers never execute on the host
- Documents the threat model and trust boundaries

### v1.9.0 — Security hardening
- Default project repos to private (currently created public; the highest-blast-radius security default)
- Webhook handler fails closed on missing or invalid signature (currently fails open if secret unset)
- Discord approval author allowlist (currently any non-bot user in #approvals can approve)
- Commit message + branch interpolation: pass via stdin instead of shell-concatenating Issue titles
- Fail-fast on missing required env vars at boot (currently silent crash minutes in)
- Pass GitHub PAT via GIT_ASKPASS instead of embedding in clone URL
- Set explicit permission overwrites on project Discord channels (currently inherit server defaults)
- XML-fence untrusted Issue body in Coder prompt with instruction guards (defense-in-depth against prompt injection)

### v1.10.0 — Cost + resilience
- Per-Issue token cap and per-project cost cap with hard stops, warnings at 50% and 80%, persisted across crashes
- Worker spawn-failure handling: don't mark an Issue handled until spawn succeeds (currently sticks forever on transient failure)
- Clear poll timers on closeProject (currently leak forever per closed project)
- Coder resume must handle the case where a remote branch already exists from a pre-crash push
- Tech Lead must not auto-merge non-Node projects without verification (currently `passed: null` silently approves)

---

## v2.x and beyond — Directional bets

Not yet committed. These are the moves that would take the project from "real software a developer can use" to "real software a non-developer can use."

### Accessibility for non-developers
- **Web UI.** Submit a brief in a form. Watch agents work in real time. Approve costs. Browse generated repos. Discord stays as the advanced/transparent view, but it stops being the primary product surface.
- **Hosted demo.** A URL where anyone can try the system without setup. The single highest-leverage thing for OSS adoption.
- **One-command local setup.** `docker-compose up` brings up everything except bring-your-own-keys.

### Platform extensibility
- **Plugin system for worker types.** Stable interface (`run(issue, context) → PR | comment`) so third parties contribute Designer, SecurityAuditor, DataEngineer, DBA, MobileDev. This is how the project becomes a platform instead of an app.
- **Plugin system for managers and Directors.** Same idea, different tier.

### Economics + learning
- **Cost dashboard with actuals.** Track real $/project from Claude API usage. Surface estimate-vs-actual in the approval flow. Over time the estimator gets real feedback and becomes evidence-based instead of theatrical.
- **Self-improvement loop.** Accepted vs. rejected PRs become training signal — either fine-tune a local reviewer or evolve prompts/standards over time. This is the long-term moat.
- **Cross-project memory.** Extend the shared research store idea. Reusable patterns, "we already solved X" registry, components and approaches that get smarter as more projects ship.

---

## Principles

These hold across all milestones:

- **Working software over impressive demos.** If a feature works only on the happy path, it isn't shipped.
- **Humans control money.** Spec approval and cost approval are non-negotiable gates.
- **Context discipline.** Ephemeral agents stay ephemeral. Persistent context belongs to the Director and durable stores, not to workers.
- **GitHub is the source of truth.** Issues are the backlog; PRs are the work; merged commits are the deliverable. Don't rebuild what GitHub already gives us.
- **The Tech Lead is a real reviewer.** Not a score generator. After v1.3 the system never merges code it hasn't verified.
