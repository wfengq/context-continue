# Changelog

## 0.1.0 (unreleased)

First release candidate of `@context-continue/core`.

- Project ledger, project board (goal, conventions, workstreams, contracts, decisions, facts, failures, open questions), private per-bot notes and long-term employee memories; SQLite and in-memory stores.
- Per-bot briefs in a fixed, cache-friendly segment order; wake rules; review and planning contexts; lead-only tools.
- Public-board switches (`publicBoard`: human directives on by default; contracts and failures optional).
- Long-project stream mode (`stream: { mode: 'off' | 'on' | 'auto' }`, `buildStream`, `recordOwnOutput`): an append-only stream with snapshots, switching on at 75 ledger entries in `auto`.

The benchmark (`packages/bench`, private) compares six context strategies on six scripted projects and can ask a real model (Anthropic or any OpenAI-compatible API) questions about key facts inside each group's context.
