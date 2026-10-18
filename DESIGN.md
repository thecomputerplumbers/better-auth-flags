# better-auth-flags: v0.1 design

Status: **proposal, for review.** Nothing below is implemented beyond the placeholder plugin.

## Why

- `kriasoft/better-auth-feature-flags` has the right feature set but has been unmaintained since Sep 2025 and is pinned to better-auth `^1.3`.
- `@emplv/better-auth-feature-flags` supports 1.7 but only does on/off per user or org.

This package aims for kriasoft's scope (minus analytics/A-B reporting) on a small, tested, current codebase.

## Packages and entries

One npm package, `@thecomputerplumbers/better-auth-flags`, three entries:

| Entry      | Contents                                                          |
| ---------- | ----------------------------------------------------------------- |
| `.`        | `featureFlags(options)` server plugin, `evaluate()` (pure), types |
| `./client` | `featureFlagsClient(options)` for `createAuthClient`              |
| `./react`  | `FlagsProvider` (optional), `useFlag`, `useFlags`                 |

Peer deps: `better-auth ^1.7`, `react` (optional). No runtime dependencies.

## Data model

Declared through the plugin's `schema` field, so `npx @better-auth/cli generate|migrate` creates the tables for every adapter (Kysely/SQL, Drizzle, Prisma, Mongo). Table names are overridable via `options.schema` like any better-auth plugin.

**`featureFlag`**

| field                 | type                                          | notes                                              |
| --------------------- | --------------------------------------------- | -------------------------------------------------- |
| id                    | string                                        |                                                    |
| key                   | string, unique                                | e.g. `new-dashboard`                               |
| type                  | `"boolean" \| "string" \| "number" \| "json"` |                                                    |
| description           | string?                                       |                                                    |
| enabled               | boolean                                       | kill switch; off = always `defaultValue`           |
| defaultValue          | string (JSON)                                 | value when no rule matches                         |
| variants              | string (JSON)?                                | allowed values + weights for multivariate rollouts |
| rolloutPercentage     | number?                                       | 0–100, boolean flags                               |
| rolloutBy             | `"user" \| "organization"`                    | hashing subject                                    |
| archivedAt            | date?                                         | soft delete                                        |
| createdAt / updatedAt | date                                          |                                                    |

**`featureFlagOverride`**: `flagId`, `subjectType` (`user` \| `organization`), `subjectId`, `value` (JSON), `expiresAt?`, `createdBy`. Unique on (flagId, subjectType, subjectId).

**`featureFlagRule`**: `flagId`, `priority` (int, lower first), `conditions` (JSON, see below), `value` (JSON) or `rolloutPercentage`, `enabled`.

No audit/evaluation-log table in v0.1 (see open questions).

## Evaluation

`evaluate(flag, context) -> { value, reason }` is a pure function with no I/O. The server loads the flag, overrides for the subject, and rules, then calls it. Order (first match wins):

1. Flag missing → caller's fallback (`reason: "missing"`); flag disabled or archived → `defaultValue` (`"disabled"`).
2. **User override** for `session.user.id` (`"user_override"`).
3. **Organization override** for the active organization (`session.session.activeOrganizationId`) (`"org_override"`).
4. **Targeting rules** by ascending priority; a rule matches when all its conditions match (`"rule"`). A rule may return a fixed value or a percentage of the matched population.
5. **Percentage rollout**: `bucket(flagKey, subjectId) < pct * 100`, where `bucket` is 32-bit FNV-1a mod 10000 over `"<key>:<subjectId>"`; subject is the user id or org id per `rolloutBy`. For multivariate flags, buckets map onto cumulative variant weights. Raising the percentage never removes anyone already in. (`"rollout"`)
6. **Default** (`"default"`).

Anonymous sessions: no user, so steps 2, 3 and user-based rollout are skipped; rules can still match on request attributes passed explicitly.

**Rule conditions** (v0.1): `{ attribute, operator, value }` where attribute is one of `user.id`, `user.email`, `user.emailDomain`, `user.role`, `user.createdAt`, `organization.id`, `organization.slug`, `member.role`, or `custom.<name>` (supplied by an `options.context(ctx)` hook). Operators: `eq`, `neq`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte`. No regex in v0.1 (ReDoS).

## Organization plugin awareness

With `organization: true` (auto-detected when the `organization` plugin is registered), the active org from the session feeds org overrides, `rolloutBy: "organization"`, and `organization.*` / `member.role` attributes. Without it, those steps are skipped. Optional `organization.adminRoles` (default `["owner", "admin"]`) allows org admins to manage _their own org's_ overrides only.

## Endpoints

Session (any signed-in or anonymous user):

| Method / path                | API              | Purpose                                                                                    |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `GET /flags/bootstrap`       | `bootstrapFlags` | all non-archived flags evaluated for the session: `{ flags: { key: value }, evaluatedAt }` |
| `GET /flags/evaluate?key=`   | `evaluateFlag`   | one flag, with `reason`                                                                    |
| `POST /flags/evaluate-batch` | `evaluateFlags`  | subset by keys                                                                             |

Admin (gated, see below): CRUD for flags (`/flags/admin/create|update|delete|list|get`), overrides (`/flags/admin/override/set|remove|list`), rules (`/flags/admin/rule/create|update|delete|reorder`).

**Admin gating:** default uses the `admin` plugin: the user's role is in `admin`'s `adminRoles` (or has the `featureFlags: ["manage"]` permission when an access-control config is used). Otherwise `options.canManage(ctx) => boolean` must be supplied; with neither, admin endpoints return 403. All admin endpoints are `requireHeaders`/session-protected and also callable server-side via `auth.api.*`.

Server helpers: `auth.api.isFlagEnabled`, `auth.api.getFlagValue`, plus a cache: `options.cache` (`{ ttlSeconds }`, in-memory per instance, default 30 s; uses better-auth `secondaryStorage` when configured).

## Client plugin

`featureFlagsClient({ bootstrapOnSession?: true, refreshInterval?: number })` adds `authClient.flags`:

- `bootstrap()` fetches `/flags/bootstrap` into an atom (nanostores, already used by better-auth's client).
- `isEnabled(key)`: boolean, `false` when unknown.
- `getValue<T>(key, fallback)`.
- `refresh()`; auto-refresh on session change (sign-in/out, active org switch) via better-auth's `$sessionSignal`.
- Admin actions are typed through `$InferServerPlugin`.
- SSR: `bootstrap` result can be passed in as `initialFlags` to avoid a request.

**React (`./react`):** `useFlag(key, fallback)` and `useFlags()` read the atom with `useSyncExternalStore`; optional `<FlagsProvider initialFlags>` for SSR hydration. No React import in the core client.

## Testing

- `evaluate` and `bucket`: exhaustive unit tests (order of precedence, every operator, rollout monotonicity and distribution, multivariate weights, a fixed bucket snapshot to catch hash changes).
- Integration: a real `betterAuth()` instance using the in-memory/SQLite (better-sqlite3 or node:sqlite) adapter with `admin` and `organization` plugins, exercising endpoints through `auth.api` and `auth.handler`, including admin 403s and org switching.
- Schema: run `@better-auth/cli generate` in CI against a fixture config and snapshot the output.
- Client: test against `auth.handler` via a custom fetch.
- CI matrix: better-auth latest 1.7.x, plus a scheduled job against `better-auth@latest` to catch breakage early.

## Out of scope for v0.1

Analytics/exposure tracking, A/B result stats, an admin UI, flag dependencies/prerequisites, scheduled changes, regex conditions, OpenFeature provider (good v0.2 candidate).

## Open questions for Seth

1. **Store values as JSON strings** (portable across all adapters) vs. typed columns? Proposal: JSON strings.
2. **Who manages flags by default:** admin-plugin role only, or also org owners/admins for their own org's overrides? Proposal: both, the second opt-in.
3. **Audit log** of flag changes in v0.1, or defer? It's cheap (one table) and useful for prod.
4. **Exposure/evaluation tracking hook** (`onEvaluate` callback) in v0.1 so you can pipe to PostHog etc.?
5. **Anonymous users:** should rollouts support a stable anonymous id (cookie) or only signed-in subjects?
6. **Migration path from kriasoft:** worth a one-off import script, or ignore?
7. **First consumer:** HiveRunner or Versal? That decides which adapter (Drizzle/Postgres?) the integration tests target first.
