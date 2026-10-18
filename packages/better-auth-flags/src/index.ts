import type { BetterAuthPlugin } from "better-auth"
import { createAuthEndpoint } from "better-auth/api"

export { bucket } from "./bucket.ts"

export type FlagValue = boolean | string | number | Record<string, unknown>

export interface FeatureFlagsOptions {
  /**
   * Placeholder. See DESIGN.md for the planned options (admin access,
   * caching, organization awareness).
   */
  organization?: boolean
}

/**
 * Server plugin. This is a placeholder that registers the plugin id and a
 * `bootstrap` endpoint returning no flags; evaluation lands after DESIGN.md
 * is reviewed.
 */
export const featureFlags = (_options: FeatureFlagsOptions = {}) =>
  ({
    id: "feature-flags",
    endpoints: {
      bootstrapFlags: createAuthEndpoint(
        "/flags/bootstrap",
        { method: "GET" },
        async (ctx) => ctx.json({ flags: {} as Record<string, FlagValue> })
      ),
    },
  }) satisfies BetterAuthPlugin
