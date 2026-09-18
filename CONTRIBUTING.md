# Contributing

The project is currently defining its contracts and architecture. Read the README, product brief, architecture, and roadmap before proposing implementation changes.

There is no issue-first requirement for small fixes. Discuss changes to authority semantics, graph commitment, public protocols, or project scope before a substantial implementation. Pull requests should explain the behavior changed and the evidence used to validate it.

Use synthetic data. Do not attach real sessions, credentials, private conversations, local paths, or unreviewed logs to issues and pull requests. Follow the public-data policy.

When implementation starts, use pnpm for JavaScript/TypeScript dependencies and preserve the selected lockfile. Use Vite Plus for development and checks where adopted. Pin dependencies after checking their current APIs. Add meaningful tests for policy, reconciliation, concurrency, durability, and transport compatibility.

A license is still pending. Resolve licensing before accepting substantive third-party code contributions or publishing reusable packages.
