# Public-data policy

This repository is intended to be public from its first commit. Its publication boundary covers file contents, filenames, history, commit metadata, issues, CI logs, screenshots, fixtures, and package contents.

## Repository content

Publish original project documentation, source, configuration templates with placeholders, and synthetic examples. Keep private planning conversations, attachments, runtime sessions, environment files, credentials, local account details, internal infrastructure addresses, and machine-specific paths outside the repository.

Use the designated public maintainer identity and a platform noreply email for commits. Do not copy global agent instructions or workstation configuration into project guidance.

The root ignore file initially allows only the reviewed documentation files. Expanding the repository for implementation requires an explicit review of newly tracked paths. Ignore rules do not remove already-tracked data and do not replace reviewing the staged diff and commit metadata.

## Runtime product requirements

- Store session context, model prompts/results, evidence, event logs, and exports outside the source checkout by default.
- Use synthetic fixtures in tests and demonstrations. Real user data requires separate, explicit publication authorization.
- Keep secrets out of source, events, diagnostic output, and provider-error dumps.
- Make provider context selection and remote data transmission visible and configurable.
- Default telemetry off; enable collection only with explicit configuration and documented content.
- Treat user context and retrieved material as data, never as authority to alter system policy or access credentials.
- Require scoped access to sessions. An opaque session ID is not automatically sufficient authorization.
- Keep local listeners local by default. Remote service deployment requires its own authentication and exposure design.

## Before publication

Review all tracked paths and staged contents, inspect author/committer metadata, search for credentials and private identifying details, and confirm only intended history is pushed. Scan results are supporting evidence, not a guarantee. New package releases also require inspecting the actual package archive.

If sensitive data is published, stop propagation, revoke affected credentials where appropriate, and follow the hosting provider's removal procedure. Removing a file in a later commit does not remove its earlier history.
