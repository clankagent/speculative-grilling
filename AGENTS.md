# Project guidance

Read README.md and docs/product-brief.md first. This repository is public; follow docs/public-data-policy.md before every commit or publication.

Keep the shared engine independent of Pi, MCP, and UI libraries. Adapters call the same application service. Maintain separate authority, epistemic, and commitment state. Model confidence cannot grant permission. Never export speculative content as committed truth.

Preserve provenance when pruning, merging, invalidating, or reopening. A branch removed to conserve compute is not a disproved alternative. All asynchronous results require revision and dependency validation.

The project targets a complete system through incremental delivery. Do not mislabel fixtures, stubs, or documentation as working integrations. Keep the roadmap and current status accurate.

Use pnpm and, where adopted, Vite Plus. Verify current SDK/protocol contracts before selecting package versions. Test policy and state invariants, crash/retry behavior, and adapter conformance.

Do not import machine-specific guidance, private setup details, raw planning transcripts, provider credentials, or real user sessions. Public examples must be synthetic. Review newly tracked paths and commit metadata as well as content.
