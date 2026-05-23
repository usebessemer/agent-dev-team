# v1.6 — Next questions

Questions surfaced during v1.6 that feed v1.7's scope candidates:

1. What's the research question for v1.7? Open — to be picked deliberately, not defaulted.
2. Does the scope-execute-approve loop hold for non-hygiene work (feature-class, design-class)?
3. The unit test suite proved insufficient for agentic-loop validation — three loop-level bugs (parallel tool_use, draft PR, pipeline draft guard) were invisible to unit tests and only surfaced in e2e. Is there a tractable way to write loop-level integration tests without live API calls, or does reliable agentic-loop coverage require a real end-to-end harness?
