# better-auth-flags

Feature flags for [better-auth](https://www.better-auth.com), maintained by The Computer Plumbers.

> **Status: pre-release.** The API below is the plan. See [DESIGN.md](./DESIGN.md) for the proposed v0.1 scope. Nothing is published to npm yet.

## Goals

- **Tracks better-auth.** Built against better-auth 1.7+ and kept current.
- **Lives in your database.** Flags, overrides and rules are tables in your better-auth schema, created by the better-auth CLI. No external service.
- **Real rollouts.** Boolean and multivariate flags, per-user and per-org overrides, targeting rules, and stable percentage rollouts.
- **Organization-aware.** Works with better-auth's `organization` plugin and the session's active organization.
- **One request on page load.** `bootstrap` returns every flag for the current session.
- **Small.** No runtime dependencies; runs on Node, Bun, Deno and Workers.

## Planned API

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

await authClient.flags.bootstrap()
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
const on = await auth.api.isFlagEnabled({
  headers,
  query: { key: "new-dashboard" },
})
```

## Development

```sh
mise run setup
mise run check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
