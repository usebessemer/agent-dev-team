# Architecture

This document defines the complete system architecture for `agent-dev-team`. Read this before touching any code.

---

## Overview

`agent-dev-team` is a tiered AI agent system that mirrors a real software development workflow. Agents communicate via Discord for human visibility and approval, and manage work through GitHub Issues and Pull Requests in per-project repos.

Three core principles:

- **Intelligence cascades down** — strategy and decisions flow from frontier models to local workers
- **Insights bubble up** — workers and managers surface observations back to the top
- **Humans stay in control** — any decision that costs money requires executive approval

---

## Design Philosophy

This system is influenced by [Late](https://github.com/mlhher/late)'s approach to agent orchestration: strict context discipline, ephemeral agent context windows, and deterministic execution. The core insight is that context pollution actively degrades model reasoning — research shows models can lose 60-80% of their effectiveness within 2-3 attempts when context is bloated.

Our solution: one persistent agent at the top, everything else ephemeral and scoped to its role.

Every role in the system must be justified by the project. Agents spin up when needed and are discarded when done. The Director is the only persistent agent.

---

## Agent Hierarchy

```
┌─────────────────────────────────────────────────────┐
│                    DIRECTOR                         │
│          (Claude Opus or Ollama — configured)       │
│                                                     │
│  Persistent global context                          │
│  Collaborates with executive to build project spec  │
│  Spins up PM + Tech Lead on spec confirmation       │
│  Listens for close: commands to end projects        │
└──────────────────────┬──────────────────────────────┘
                       │ confirmed spec
           ┌───────────┴───────────┐
           │                       │
┌──────────▼──────┐       ┌────────▼────────┐
│    PM AGENT     │       │   TECH LEAD     │
│  (ephemeral)    │       │   (ephemeral)   │
│                 │       │                 │
│  Creates project│       │  Coding stds    │
│  GitHub repo    │       │  PR review      │
│  GitHub Issues  │       │  PR merge       │
│  Cost estimates │       │  Close detect   │
│  Discord posts  │       │                 │
└──────────┬──────┘       └─────────────────┘
           │ confirmed estimate
           │
┌──────────▼──────────────────────────────────────────┐
│                 WORKER AGENTS                       │
│         (Claude API or Ollama — configured)         │
│                                                     │
│   Coder         Writer        Researcher            │
│   type:feature  type:docs     type:research         │
│   (default)                                         │
│                                                     │
│   Ephemeral — spawned per GitHub Issue              │
│   Routed by Issue label                             │
│   Coder/Writer: branch → work → PR → discard       │
│   Researcher: research → Issue comment → discard    │
└─────────────────────────────────────────────────────┘
```

---

## Three-Repo Architecture

`agent-dev-team` uses a three-repo model. Each project gets its own dedicated GitHub repo.

```
agent-dev-team repo (this repo)
  └── Agent infrastructure only

bessemer-state repo (usebessemer/bessemer-state)
  └── estimation-history.json — shared state across all projects

{project-name} repo (created per project by PM)
  ├── GitHub Issues — project task backlog
  ├── Worker branches — one per Issue
  ├── Pull Requests — one per Coder/Writer branch
  └── Merged code — final deliverables
```

This keeps `agent-dev-team` clean as infrastructure-only. Project code lives in its own deployable repo.

---

## How Agents Communicate

There is no in-process message bus. Agents coordinate through three real channels:

- **Discord** — human visibility and approval gates. Bots post to the project channel via `postToChannel`; workers post via webhook via `postAsWorker`. Each project gets its own `#proj-{name}` channel created automatically by the pipeline.
- **GitHub Issues** — the task backlog. PM creates Issues from the spec; the pipeline's `watchIssues` poller spawns workers; workers advance Issues through label states (`status:backlog` → `status:review` → `status:complete`).
- **GitHub PRs** — the work handoff. Coder/Writer workers open PRs; the `watchPRs` poller triggers Tech Lead review; merge closes the Issue.

---

## Human Confirmation Gates

Nothing spins up without executive confirmation. Two hard gates before any work starts:

```
Gate 1 — Spec confirmation (multi-turn)
  Executive → #director: "brief: {description}"
  Director generates draft spec (tech-stack-aware, LLM-produced)
  Director posts draft to #director for review
  Executive refines in plain language — as many turns as needed
  Executive types 'confirm' → Director sends spec to #approvals
  approve → Director spins up PM + Tech Lead
  (type 'cancel' at any point to clear the draft and start over)

Gate 2 — Cost estimate confirmation
  PM reads estimation-history.json from bessemer-state
  PM builds cost estimate (historical mean if ≥ 3 past projects match
  projectType, otherwise LLM cold-start estimate)
  PM → #approvals (type 'approve' or 'reject')
  approve → PM creates project repo + Issues, workers spawn
```

---

## Worker Execution Model

> **Host execution warning:** Workers clone the project repo into a tempdir and run model-generated shell commands directly on the host via `child_process.exec`. There is no container isolation until v1.8. Do not run this system on a machine where arbitrary code execution is unacceptable.

Workers are stateless, ephemeral agents. A fresh worker is spawned for each GitHub Issue. Routing is determined by the Issue's `type:*` label, set by the PM when it creates Issues.

**Coder** (`type:feature` or unlabelled)
- Spawn → generate code (single model call) → commit → open PR → discard

**Writer** (`type:docs`)
- Spawn → generate written artifact (README, changelog, etc.) → commit → open PR → discard

**Researcher** (`type:research`)
- Spawn → run research prompt → post findings as Issue comment → close Issue → discard
- No branch or PR — research is delivered directly to the Issue

**Failure handling (Coder and Writer):**
- 3-attempt self-healing loop for commit/API failures
- On 3rd failure → escalation fires → Issue labelled `status:blocked`, alert posted to `#alerts`
- Rejected PRs → Issue requeued → worker respawns on next poll

**One worker per Issue — always:**
```
One GitHub Issue = One Worker = One Branch = One PR
No exceptions (for Coder and Writer).
```

---

## Pipeline Flow

```
PHASE 1 — BRIEF (multi-turn)
Executive → #director: "brief: [project-name] {description}"
Director generates draft spec (LLM-produced, tech-stack-aware)
Director posts draft to #director
Executive refines with plain-language instructions (repeat as needed)
Executive types 'confirm' → spec sent to #approvals (type 'approve' or 'reject')

PHASE 2 — TEAM SPINUP
Director spins up PM + Tech Lead (ephemeral, simultaneously)
Pipeline creates #proj-{name} Discord channel + webhook
Tech Lead defines coding standards immediately
PM reads estimation-history.json from bessemer-state
PM builds cost estimate
PM → #approvals (type 'approve' or 'reject')

PHASE 3 — PROJECT SETUP
PM creates GitHub repo for the project
PM creates GitHub Labels in project repo
PM creates GitHub Issues from spec deliverables in project repo

PHASE 4 — EXECUTION
PM registers GitHub webhook on project repo (issues + pull_request events)
Webhook receiver (port WEBHOOK_PORT) is primary trigger for workers and reviews
Pollers run every 5 minutes as safety net for dropped webhooks
Worker spawns per Issue based on type: label (Coder / Writer / Researcher)
Coder/Writer: branch → work → commit → PR → discard
Researcher: research → Issue comment → close Issue → discard
Tech Lead reviews PRs → merges or rejects
Rejected PRs → Issue requeued → worker respawns on next trigger
Merged PRs → Issue closed → Tech Lead checks completion

PHASE 5 — CLOSE DETECTION
After each merge, Tech Lead checks for 0 open PRs + 0 open Issues
When complete:
  Tech Lead → #director: "Project {name} appears complete"
  Posts project repo link and close instructions

PHASE 6 — CLOSE CONFIRMATION
Executive reviews project repo on GitHub
Executive → #director: "close: {project-name}"
Pipeline writes estimate to bessemer-state estimation history
PM + Tech Lead discard (Discord clients destroyed)
Project channel archived (renamed archived-proj-{name}, set read-only)
Director → #director: "Project {name} closed"
```

---

## Spec Generation

The Director generates a complete spec from the brief in a single LLM call. The model produces:

- `projectName` — kebab-case, max 30 chars
- `projectType` — one of `cli`, `web-app`, `api-service`, `data-pipeline`, `docs-site`
- `architecture` — overview, components, `techStack` (language, runtime, packages)
- `deliverables` — array with `name`, `type`, `description`, `acceptanceCriteria`

The spec is validated against `src/contracts/spec.schema.json`. On failure the error is fed back into the prompt and the call is retried up to 3 times. After exhaustion it falls back to a generic Express spec. The validated spec is stored in `activeBriefs[channelId]` until the executive confirms it.

---

## Estimation Memory

The PM reads from a shared estimation history in the `bessemer-state` repo on spawn. After a project closes, the pipeline writes the estimate back.

- Remote: `usebessemer/bessemer-state/estimation-history.json`
- Local fallback: `projects/estimation-history.json` (used if bessemer-state is unreachable)

Both locations use the same JSON schema:
```json
{ "projects": [ { "projectName", "projectType", "closedAt",
    "estimate": { "hours", "cost", "currency" },
    "actuals":  { "hours", "cost", "currency" },
    "variance" } ] }
```

**Estimation logic:**
- Filter history by `projectType` (last 5 entries)
- **≥ 3 matches** → use mean of `actuals.hours` (or `estimate.hours` as proxy); `confidence: medium`
- **< 3 matches** → LLM cold-start estimate; `confidence: low`; notes say *"Insufficient history (N/3 required)"* or *"Cold start"* when zero matches exist

---

## Discord Structure

```
📁 ORG-WIDE (permanent)
  #director       ← briefs, specs, project status, close commands
  #approvals      ← human confirmation gates (type 'approve'/'reject')
  #alerts         ← worker escalations and system issues

📁 PER-PROJECT (auto-created, auto-archived)
  #proj-{name}    ← all agent activity for this project
                     managers post here; workers post via webhook
                     renamed to archived-proj-{name} on close
```

**Bot identity model:**

```
Persistent bots (always running):
  🤖 Director

Per-project bots (ephemeral — spawned with PM and Tech Lead):
  🤖 PM
  🤖 TechLead

Workers post via webhook — no bot token, no persistent identity.
```

**Multi-project approval:** Approval messages in `#approvals` now show `approve: {project-name}` / `reject: {project-name}` syntax. Both the scoped form and plain `approve`/`reject` are accepted. The scoped form prevents ambiguity when two projects are waiting for approval simultaneously.

**Note on concurrency:** `PM_TOKEN` and `TECHLEAD_TOKEN` are global env vars. Two simultaneous projects each create a PM and TechLead instance sharing the same Discord session (same bot). They post to different project channels, so output is separated. True per-session isolation would require separate tokens — a v2.x improvement.

---

## Known Limitations (v1.5)

- **Workers execute on the host** — Coder and Tech Lead run model-generated shell commands directly on the host in a tempdir; there is no container isolation. Real sandboxing is tracked for v1.8.
- **No test runners for non-Node projects** — `runTests` returns `passed: null` for any project without a Node `test` script, and Tech Lead currently treats null as approved. Honest behaviour tracked for v1.10.
- **Shared bot sessions** — Two concurrent projects share the same PM Discord session and the same TechLead Discord session (`PM_TOKEN`/`TECHLEAD_TOKEN` are global). Output is separated by project channel; approval disambiguation is handled by the `approve: {name}` syntax. True session isolation requires separate tokens.
- **5-min polling fallback** — Webhooks are the primary trigger (v1.5). Pollers run every 5 minutes as a safety net for dropped webhooks. Projects without `WEBHOOK_URL`/`GITHUB_WEBHOOK_SECRET` configured still rely on the 5-min poller.
- **Estimation bootstrapping** — The historical mean requires 3+ past projects of the same `projectType`. New deployments and new project types always cold-start on the LLM estimate. Confidence improves naturally as the history grows.
- **Actuals not tracked** — On project close, `actuals` is written as a copy of `estimate` (variance = 0). Tracked for v1.7.
- **Tech Lead self-approval** — when `TECHLEAD_GITHUB_TOKEN` is not set, Tech Lead posts a comment instead of a formal review (GitHub prevents self-approval on the same account). Set the optional separate token to enable formal `APPROVE`/`REQUEST_CHANGES` reviews.
