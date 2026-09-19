# Browser workspace

The primary human surface is a decision queue with a focused comparison. Pi and MCP use this same service; host elicitation is an explicit fallback.

## Composition and interaction

Keep all decisions visible in a compact queue, grouped by readiness. Selecting a row opens its comparison immediately; there is no enforced order or blocking wizard. Options sit side by side on a shared baseline. Each has a direct, explicitly labeled choice action. Custom answers, evidence and activity are disclosed on demand. Save an answer, update the queue, and move to the next available decision. Background work continues independently.

The graph is an SVG DAG with directed dependency edges and condition labels. Nodes are keyboard-accessible links to the corresponding decision. Initial fit, zoom and scrolling support larger graphs. Independent decisions remain unconnected; do not invent edges for visual completeness.

This is an adaptation of the operational direction to a light, paper-like comparison surface: a dense queue, large question, medium option titles, short findings, and quiet secondary controls. Warm neutral backgrounds, black type, a restrained rust selection accent, and flat separators distinguish navigation from the decision. Do not surround each content fragment in another card. Connection success, generic mottos and repeated instructional paragraphs are absent. Connection failures remain visible.

The [Linear interface rationale](https://linear.app/now/behind-the-latest-design-refresh) and rendered comparisons were inspected during the initial design. Its distinction between orientation and working content remains relevant; the earlier card-heavy implementation failed to apply that hierarchy. The current composition uses the evidence already gathered rather than collecting more references as a substitute for interaction design.

On phones the queue becomes a horizontally scrollable strip, with both options visible together below it. All actions remain reachable. The desktop graph initially fits its pane. On phones it keeps legible node sizes with horizontal scrolling; Fit and zoom remain available.

## Data boundaries

The offline example uses deterministic synthetic analysis through the real event-sourced service. It makes no provider calls. A small Example label opens a brief describing that boundary. Real-session provider transmission is described in the brief dialog. Credentials stay on the server. Findings come from stored branch work; missing findings are shown as unexplored, never invented. Pending agent interpretations require human acceptance.
