import type { FlagValue } from "./types.ts"

export interface FlagsState {
  flags: Record<string, FlagValue>
  /** True once flags came from the server or `initialFlags`. */
  loaded: boolean
  evaluatedAt: string | null
  error: unknown
}

export interface FlagsStore {
  get(): FlagsState
  set(state: FlagsState): void
  subscribe(listener: (state: FlagsState) => void): () => void
}

/** A minimal observable store (no dependencies, framework-agnostic). */
export function createFlagsStore(
  initialFlags?: Record<string, FlagValue>
): FlagsStore {
  let state: FlagsState = {
    flags: initialFlags ?? {},
    loaded: initialFlags !== undefined,
    evaluatedAt: null,
    error: null,
  }
  const listeners = new Set<(s: FlagsState) => void>()
  return {
    get: () => state,
    set(next) {
      state = next
      for (const l of listeners) l(state)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

let defaultStore: FlagsStore | null = null
/** The store of the most recently created `featureFlagsClient`. */
export const getDefaultFlagsStore = () => defaultStore
export const setDefaultFlagsStore = (s: FlagsStore) => {
  defaultStore = s
}

export function readFlag<T extends FlagValue>(
  state: FlagsState,
  key: string,
  fallback: T
): T {
  return Object.hasOwn(state.flags, key) ? (state.flags[key] as T) : fallback
}
