import type { BetterAuthClientPlugin } from "better-auth/client"
import type { featureFlags } from "./server.ts"

export type { FlagValue } from "./types.ts"

/** Client plugin. Placeholder; see DESIGN.md for isEnabled/getValue/bootstrap. */
export const featureFlagsClient = () =>
  ({
    id: "feature-flags",
    $InferServerPlugin: {} as ReturnType<typeof featureFlags>,
  }) satisfies BetterAuthClientPlugin
