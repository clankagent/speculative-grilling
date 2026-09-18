# Integration research

Checked on 2026-09-18. References are compatibility evidence, not completed integration tests. Exact package versions and API signatures still need pinning before implementation.

## MCP

The official [2026-07-28 release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/) confirms the stateless protocol core, Multi Round-Trip Requests, formal extensions, and updated SDKs. Use the dated protocol name rather than treating “MCP 2.0” as an unambiguous protocol version. The [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) is the package/API reference to inspect when pinning dependencies.

The [Tasks documentation](https://tasks.extensions.modelcontextprotocol.io/) describes durable handles, per-request capability declaration, polling, and mid-flight input through tasks/update. It defines working, input_required, completed, failed, and cancelled states. A domain state such as “exploring with questions available” belongs in application metadata, not a custom task status.

The [MCP Apps overview](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html) describes sandboxed interactive views and progressive enhancement. A rich App is optional; the engine's essential operations must remain usable through structured tools.

## Pi

The historical badlogic/pi-mono extension-documentation URL currently redirects to [earendil-works/pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md). The supplied planning material also cites forks. Select and pin the intended upstream distribution before depending on fork-specific APIs.

Still to verify in an executable integration: supported extension APIs, persistence and restart behavior, tool cancellation, background work during focused interaction, and installation/package conventions.

## Jev

The [Vercel Jev announcement](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway) provides a primary integration reference. The exact provider API, schemas, score interpretation, limits, pricing, and data handling need verification before live integration and calibration.

The supplied Pydantic documentation URL was not retrievable during this check. Do not treat the earlier conversation's claims about numerical confidence semantics as a verified SDK contract.

## Claims intentionally not adopted

No claim that this is the first public implementation, no measured question-reduction claim, and no numerical scheduling thresholds are established. Literature references from the initial discussion have not been validated as part of this kickoff. The roadmap defines how to evaluate the project's own behavior without relying on those claims.
