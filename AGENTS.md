# better-auth-flags

A better-auth plugin (server + client) for database-backed feature flags. Read DESIGN.md before implementing anything; it is the source of truth for scope and evaluation order.

## Invariants

- Built on better-auth's plugin APIs only (`BetterAuthPlugin`, `createAuthEndpoint`, plugin `schema`). No direct database driver access; use the adapter from the endpoint context.
- Evaluation is a pure function (`src/evaluate.ts`) with no I/O, so it can be unit tested exhaustively and reused on the client.
- Rollout bucketing must be stable: the same flag key + subject id always lands in the same bucket across versions. Changing the hash is a breaking change.
- `src/react.ts` is a separate entry; the core client entry must not import React.

## Commits and releases

PR titles are Conventional Commits (squash-merged; release-please builds versions and changelogs). See CONTRIBUTING.md. Never bump versions or publish by hand.

## Checks

`mise run check`.
