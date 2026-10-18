import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  createFlagsStore,
  getDefaultFlagsStore,
  readFlag,
  type FlagsState,
  type FlagsStore,
} from "./store.ts"
import type { FlagValue } from "./types.ts"

const FlagsContext = createContext<FlagsStore | null>(null)

export interface FlagsProviderProps {
  /**
   * The flags store, e.g. `authClient.flags.store`. Defaults to the most
   * recently created `featureFlagsClient`.
   */
  store?: FlagsStore
  /** Server-rendered flags; seeds the store if it hasn't loaded yet. */
  initialFlags?: Record<string, FlagValue>
  children?: ReactNode
}

/** Optional. Needed only to pass a specific store or SSR `initialFlags`. */
export function FlagsProvider(props: FlagsProviderProps) {
  const store = useMemo(() => {
    const s =
      props.store ??
      getDefaultFlagsStore() ??
      createFlagsStore(props.initialFlags)
    if (props.initialFlags && !s.get().loaded)
      s.set({ ...s.get(), flags: props.initialFlags, loaded: true })
    return s
  }, [props.store, props.initialFlags])
  return createElement(FlagsContext.Provider, { value: store }, props.children)
}

const EMPTY: FlagsState = {
  flags: {},
  loaded: false,
  evaluatedAt: null,
  error: null,
}
const noopSubscribe = () => () => {}

function useStore(): FlagsStore | null {
  return useContext(FlagsContext) ?? getDefaultFlagsStore()
}

/** All flags plus loading state. Re-renders when they change. */
export function useFlags(): FlagsState {
  const store = useStore()
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (store ? store.get() : EMPTY),
    () => (store ? store.get() : EMPTY)
  )
}

/** One flag's value, or `fallback` until it's known. */
export function useFlag<T extends FlagValue>(key: string, fallback: T): T {
  return readFlag(useFlags(), key, fallback)
}

/** `true` only when the flag's value is exactly `true`. */
export function useFlagEnabled(key: string): boolean {
  return useFlags().flags[key] === true
}
