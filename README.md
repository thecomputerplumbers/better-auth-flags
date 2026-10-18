# better-auth-flags

Feature flags for [better-auth](https://www.better-auth.com), maintained by The Computer Plumbers.

> **Status: v0.1, not yet on npm.** See [DESIGN.md](./DESIGN.md) for the full design.

## Goals

- **Tracks better-auth.** Built against better-auth 1.7+ and kept current.
- **Lives in your database.** Flags, overrides and rules are tables in your better-auth schema, created by the better-auth CLI. No external service.
- **Real rollouts.** Boolean and multivariate flags, per-user and per-org overrides, targeting rules, and stable percentage rollouts.
- **Organization-aware.** Works with better-auth's `organization` plugin and the session's active organization.
- **One request on page load.** `bootstrap` returns every flag for the current session.
- **Small.** No runtime dependencies; runs on Node, Bun, Deno and Workers.

## Usage

```ts
// auth.ts
import { betterAuth } from "better-auth"
import { admin, organization } from "better-auth/plugins"
import { featureFlags } from "@thecomputerplumbers/better-auth-flags"

export const auth = betterAuth({
  plugins: [admin(), organization(), featureFlags({ organization: true })],
})
```

```ts
// auth-client.ts
import { createAuthClient } from "better-auth/client"
import { featureFlagsClient } from "@thecomputerplumbers/better-auth-flags/client"

export const authClient = createAuthClient({ plugins: [featureFlagsClient()] })

await authClient.flags.load()
authClient.flags.isEnabled("new-dashboard") // boolean
authClient.flags.getValue("checkout-variant", "control") // "control" | "b" | ...
```

```tsx
// React
import { useFlag } from "@thecomputerplumbers/better-auth-flags/react"

const enabled = useFlag("new-dashboard", false)
```

```ts
// Server
const { enabled } = await auth.api.isFlagEnabled({
  headers,
  query: { key: "new-dashboard" },
})

// Admin (site admins via the admin plugin, or `canManage`); every change is audited
await auth.api.createFlag({
  headers,
  body: {
    key: "new-dashboard",
    type: "boolean",
    defaultValue: false,
    rolloutPercentage: 10,
  },
})
await auth.api.setFlagOverride({
  headers,
  body: {
    key: "new-dashboard",
    subjectType: "organization",
    subjectId: orgId,
    value: true,
  },
})
const { entries } = await auth.api.listFlagAudit({
  headers,
  query: { flagKey: "new-dashboard" },
})
```

## Development

Then create the tables with `npx @better-auth/cli generate` (Drizzle/Prisma) or `migrate` (built-in Kysely).

```sh
mise run setup
mise run check     # lint, format, typecheck, build, unit + memory-adapter tests
mise run test:pg   # Postgres integration tests in Docker
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
