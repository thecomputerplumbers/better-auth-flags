# better-auth-flags: v0.1 design

Status: **v0.1 implemented** (unreleased) (decisions from Seth, Oct 18 2026, are recorded under [Decisions](#decisions)).

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

Peer deps: `better-auth ^1.7`, `zod ^4` and `nanostores ^1` (both already required by better-auth), `react` (optional). No other runtime dependencies.

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

**`featureFlagAudit`**: `flagId?`, `flagKey`, `action` (`flag.create` \| `flag.update` \| `flag.delete` \| `override.set` \| `override.remove` \| `rule.create` \| `rule.update` \| `rule.delete`), `actorId` (user id or null for server calls), `before` (JSON?), `after` (JSON?), `createdAt`. Written on every admin mutation, in the same request. Rows are never updated or deleted by the plugin, and `flagKey` is denormalised so history survives flag deletion.

Ids are left to the adapter, so `advanced.database.generateId: false` with database-generated ids (as Versal uses with Postgres `uuidv7()`) works.

There is no evaluation-log table; use `onEvaluate` instead.

## Evaluation

`evaluate(flag, context) -> { value, reason }` is a pure function with no I/O. The server loads the flag, overrides for the subject, and rules, then calls it. Order (first match wins):

1. Flag missing → caller's fallback (`reason: "missing"`); flag disabled or archived → `defaultValue` (`"disabled"`).
2. **User override** for `session.user.id` (`"user_override"`).
3. **Organization override** for the active organization (`session.session.activeOrganizationId`) (`"org_override"`).
4. **Targeting rules** by ascending priority; a rule matches when all its conditions match (`"rule"`). A rule may return a fixed value or a percentage of the matched population.
5. **Percentage rollout**: `bucket(flagKey, subjectId) < pct * 100`, where `bucket` is 32-bit FNV-1a mod 10000 over `"<key>:<subjectId>"`; subject is the user id or org id per `rolloutBy`. For multivariate flags, buckets map onto cumulative variant weights. Raising the percentage never removes anyone already in. (`"rollout"`)
6. **Default** (`"default"`).

Anonymous sessions: no user, so steps 2, 3 and rollouts are skipped (a rollout falls through to the default); rules can still match on `custom.*` attributes. Stable anonymous-id rollouts are out of scope.

**`onEvaluate` hook:** `options.onEvaluate?: (event: { key, value, reason, userId, organizationId, ctx }) => void | Promise<void>`, called once per evaluated flag (bootstrap included). It is fire-and-forget: errors are caught and logged, and it never changes the result or blocks the response.

**Rule conditions** (v0.1): `{ attribute, operator, value }` where attribute is one of `user.id`, `user.email`, `user.emailDomain`, `user.role`, `user.createdAt`, `organization.id`, `organization.slug`, `member.role`, or `custom.<name>` (supplied by an `options.context(ctx)` hook). Operators: `eq`, `neq`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte`. No regex in v0.1 (ReDoS).

## Organization plugin awareness

With `organization: true` (auto-detected when the `organization` plugin is registered), the active org from the session feeds org overrides, `rolloutBy: "organization"`, and `organization.*` / `member.role` attributes. Without it, those steps are skipped. Org owners and admins get no flag management rights; only site admins manage flags (see Admin gating).

## Endpoints

Session (any signed-in or anonymous user):

| Method / path                | API              | Purpose                                                                                    |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `GET /flags/bootstrap`       | `bootstrapFlags` | all non-archived flags evaluated for the session: `{ flags: { key: value }, evaluatedAt }` |
| `GET /flags/evaluate?key=`   | `evaluateFlag`   | one flag, with `reason`                                                                    |
| `POST /flags/evaluate-batch` | `evaluateFlags`  | subset by keys                                                                             |

Admin (gated, see below): CRUD for flags (`/flags/admin/create|update|delete|list|get`), overrides (`/flags/admin/override/set|remove|list`), rules (`/flags/admin/rule/create|update|delete`), and the audit log (`GET /flags/admin/audit?flagKey=&actorId=&limit=&offset=`, newest first).

**Admin gating (site admins only):** when the `admin` plugin is registered, a user may manage flags if their `role` (comma-separated roles supported) is in the admin plugin's `adminRoles` (default `["admin"]`) or their id is in `adminUserIds`. `options.canManage(session, ctx) => boolean | Promise<boolean>` replaces that check when supplied. With neither, admin endpoints return 403. Organization roles never grant access. All admin endpoints are `requireHeaders`/session-protected and also callable server-side via `auth.api.*`.

Server helpers: `auth.api.isFlagEnabled` (`GET /flags/is-enabled`) and `auth.api.evaluateFlag`. Admin endpoints called server-side through `auth.api` without headers are trusted and audited with a null actor. Cache: `options.cache` (`{ ttlSeconds }`, in-memory per instance, default 30 s, 0 disables); admin writes through the instance clear it. `secondaryStorage` support is deferred to v0.2.

Percentages are integers 0–100 in v0.1 (better-auth `number` columns are integers on Postgres).

## Client plugin

`featureFlagsClient({ bootstrapOnSession?: true, refreshInterval?: number })` adds `authClient.flags`:

- `load()` (alias `refresh()`) fetches `/flags/bootstrap` into the flags store. `flags.bootstrap()` stays the raw, typed endpoint call, because better-auth infers it from the server route.
- `isEnabled(key)`: boolean, `false` when unknown.
- `getValue<T>(key, fallback)`.
- `getAll()`, `store`; in the browser, loads on start and auto-refreshes on session change (`$sessionSignal`) and on active-org switches or admin writes made through the client. Concurrent loads share one request.
- Admin actions are typed through `$InferServerPlugin` (`authClient.flags.admin.*`).
- SSR: `bootstrap` result can be passed in as `initialFlags` to avoid a request.

**React (`./react`):** `useFlag(key, fallback)`, `useFlagEnabled(key)` and `useFlags()` read the store with `useSyncExternalStore`; optional `<FlagsProvider initialFlags>` for SSR hydration. No React import in the core client.

## Testing

- `evaluate` and `bucket`: exhaustive unit tests (order of precedence, every operator, rollout monotonicity and distribution, multivariate weights, a fixed bucket snapshot to catch hash changes).
- Integration: a real `betterAuth()` instance with `admin` and `organization` plugins, exercising endpoints through `auth.api` and `auth.handler`, including admin 403s, audit rows and org switching. Run against the memory adapter (fast, every `check`) and against Postgres with both the Drizzle adapter (Versal's setup, `provider: "pg"`, `generateId: false`) and the built-in Kysely/pg adapter (`pnpm test:pg`, Docker locally and a Postgres service in CI).
- Schema: run `@better-auth/cli generate` in CI against a fixture config and snapshot the output.
- Client: test against `auth.handler` via a custom fetch.
- CI matrix: better-auth latest 1.7.x, plus a scheduled job against `better-auth@latest` to catch breakage early.

## Out of scope for v0.1

Analytics/exposure tracking, A/B result stats, an admin UI, flag dependencies/prerequisites, scheduled changes, regex conditions, OpenFeature provider (good v0.2 candidate).

## Decisions

Answered by Seth on Oct 18 2026:

1. Values are stored as JSON strings.
2. Only site admins manage flags. No org owner/admin self-service.
3. An audit log of flag changes ships in v0.1 (`featureFlagAudit`, admin endpoint to query it).
4. An `onEvaluate` hook ships in v0.1.
5. No anonymous-id rollouts for now.
6. No migration script from kriasoft.
7. Versal is the first user: Drizzle adapter on Postgres (Aurora), better-auth 1.7.x with `organization`, `admin`, `twoFactor`, `jwt` and MCP plugins. Integration tests target that first.
