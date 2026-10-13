# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-10-13

### Added

- Publishable package entry point (`src/index.ts`, `exports`, `main`, `types`, declaration + source maps).
- GitHub Actions CI (Node 20 & 22: lint, typecheck, test, build) and a release-only npm publish workflow.
- ESLint (flat config), `LICENSE`, `CHANGELOG.md`, and `.nvmrc`.
- Server options `maxJobs`, `jobTimeoutMs`, and a structured `onError` hook.
- Client options `maxRounds`, `maxResponseBytes`, and per-call `signal` / `maxRounds` on `ClientCallRequest`.
- Bounded `MemoryRequestStore` (oldest entries evicted beyond `maxRecords`, default 1000).
- Tests for auth/redaction, invalid resume tokens, unknown routes/jobs, method handling,
  oversized/invalid bodies, unknown client services, round limits, and duplicate external callbacks.
- Demo moved to `examples/demo.ts` so the published build contains only the library.

### Changed

- Resume tokens are rotated on every negotiation round and are single-round.
- Tokens (resume + external callback) are stored only as SHA-256 hashes and
  compared with `timingSafeEqual`.
- Sensitive request headers (`Authorization`, `Cookie`, `x-api-key`, …) are
  redacted as `[REDACTED]` before anything is written to a `RequestStore`.
- `server.close()` now rejects pending rounds/callbacks and force-closes
  keep-alive sockets instead of hanging.
- PostgreSQL store initialisation is shared across concurrent `save()` calls
  and creates a `created_at` index.
- Stricter TypeScript: `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

### Security

- Abandoned jobs now expire (`JOB_EXPIRED`) instead of leaking in memory forever.
- The client can no longer be looped forever by a misbehaving server
  (`MAX_ROUNDS_EXCEEDED`, non-advancing rounds are rejected) and responses
  are size-capped (`RESPONSE_TOO_LARGE`).

## [1.1.0]

- Initial TypeScript implementation: `NegotiationClient`, `NegotiationServer`,
  client services, server actions, external callbacks, in-memory and
  PostgreSQL request stores, and a delivery-estimate demo.
