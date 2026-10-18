import type { BetterAuthClientPlugin } from "better-auth/client"
import { atom } from "nanostores"
import type { FeatureFlagsPlugin } from "./server.ts"
import {
  createFlagsStore,
  readFlag,
  setDefaultFlagsStore,
  type FlagsState,
  type FlagsStore,
} from "./store.ts"
import type { FlagValue } from "./types.ts"

export type { FlagsState, FlagsStore } from "./store.ts"
export type { FlagValue } from "./types.ts"

export interface FeatureFlagsClientOptions {
  /** Flags rendered on the server, to skip the first request. */
  initialFlags?: Record<string, FlagValue>
  /**
   * Fetch flags on load (in the browser) and again whenever the session or
   * active organization changes. Default true.
   */
  bootstrapOnSession?: boolean
  /** Also refetch every N milliseconds. Off by default. */
  refreshInterval?: number
}

const REFRESH_PATHS = [
  "/organization/set-active",
  "/organization/create",
  "/organization/leave",
  "/flags/admin/",
]

export const featureFlagsClient = (options: FeatureFlagsClientOptions = {}) => {
  const store = createFlagsStore(options.initialFlags)
  setDefaultFlagsStore(store)
  const $flagsSignal = atom(false)

  return {
    id: "feature-flags",
    $InferServerPlugin: {} as FeatureFlagsPlugin,
    pathMethods: {
      "/flags/bootstrap": "GET",
      "/flags/evaluate": "GET",
      "/flags/is-enabled": "GET",
      "/flags/evaluate-batch": "POST",
    },
    atomListeners: [
      {
        matcher: (path: string) =>
          REFRESH_PATHS.some((p) => path.startsWith(p)),
        signal: "$flagsSignal",
      },
    ],
    getAtoms: () => ({ $flagsSignal }),
    getActions: ($fetch, $store) => {
      let inflight: Promise<FlagsState> | null = null
      async function bootstrap(): Promise<FlagsState> {
        if (inflight) return inflight
        inflight = (async () => {
          const res = await $fetch<{
            flags: Record<string, FlagValue>
            evaluatedAt: string
          }>("/flags/bootstrap", { method: "GET" })
          const prev = store.get()
          const next: FlagsState = res.data
            ? {
                flags: res.data.flags,
                loaded: true,
                evaluatedAt: res.data.evaluatedAt,
                error: null,
              }
            : { ...prev, error: res.error }
          store.set(next)
          return next
        })().finally(() => {
          inflight = null
        })
        return inflight
      }

      if (
        options.bootstrapOnSession !== false &&
        typeof window !== "undefined"
      ) {
        let first = true
        const onChange = () => {
          // The first notification is the subscription itself; skip it when
          // server-rendered flags were supplied.
          if (first && options.initialFlags) {
            first = false
            return
          }
          first = false
          void bootstrap()
        }
        $store.listen("$sessionSignal", onChange)
        $flagsSignal.listen(() => void bootstrap())
        if (options.refreshInterval)
          setInterval(() => void bootstrap(), options.refreshInterval)
      }

      return {
        flags: {
          /**
           * Fetches every flag for the current session into the store.
           * (`flags.bootstrap()` is the raw endpoint call and doesn't touch
           * the store.)
           */
          load: bootstrap,
          /** Same as `load`. */
          refresh: bootstrap,
          /** `true` only when the flag's value is exactly `true`. */
          isEnabled: (key: string): boolean => store.get().flags[key] === true,
          /** The flag's value, or `fallback` when it isn't known. */
          getValue: <T extends FlagValue>(key: string, fallback: T): T =>
            readFlag(store.get(), key, fallback),
          getAll: (): Record<string, FlagValue> => store.get().flags,
          /** The underlying store (used by the React bindings). */
          store: store as FlagsStore,
        },
      }
    },
  } satisfies BetterAuthClientPlugin
}
