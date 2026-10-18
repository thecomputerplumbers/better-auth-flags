import assert from "node:assert/strict"
import { beforeEach, describe, test } from "node:test"
import { createAuthClient } from "better-auth/client"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { featureFlagsClient } from "../src/client.ts"
import {
  FlagsProvider,
  useFlag,
  useFlagEnabled,
  useFlags,
} from "../src/react.ts"
import { createFlagsStore } from "../src/store.ts"
import { BASE_URL, makeAuth, signUp, type Auth } from "./helpers.ts"

let auth: Auth

function client(
  headers?: Headers,
  opts?: Parameters<typeof featureFlagsClient>[0]
) {
  return createAuthClient({
    baseURL: BASE_URL,
    fetchOptions: {
      customFetchImpl: async (input, init) => {
        const req = new Request(input, init)
        headers?.forEach((v, k) => req.headers.set(k, v))
        req.headers.set("origin", BASE_URL)
        return auth.handler(req)
      },
    },
    plugins: [featureFlagsClient(opts)],
  })
}

describe("client plugin", () => {
  let userH: Headers
  let userId: string
  beforeEach(async () => {
    auth = makeAuth()
    ;({ headers: userH, userId } = await signUp(auth, "ada@acme.test"))
    await auth.api.createFlag({
      body: { key: "on", type: "boolean", defaultValue: true },
    })
    await auth.api.createFlag({
      body: { key: "off", type: "boolean", defaultValue: false },
    })
    await auth.api.createFlag({
      body: { key: "variant", type: "string", defaultValue: "control" },
    })
    await auth.api.setFlagOverride({
      body: { key: "off", subjectType: "user", subjectId: userId, value: true },
    })
  })

  test("load fetches flags; isEnabled and getValue read them", async () => {
    const c = client(userH)
    assert.equal(c.flags.isEnabled("on"), false, "nothing before bootstrap")
    assert.equal(c.flags.getValue("variant", "fallback"), "fallback")
    const state = await c.flags.load()
    assert.equal(state.loaded, true)
    assert.equal(c.flags.isEnabled("on"), true)
    assert.equal(c.flags.isEnabled("off"), true, "user override")
    assert.equal(
      c.flags.isEnabled("variant"),
      false,
      "non-boolean is never enabled"
    )
    assert.equal(c.flags.getValue("variant", "x"), "control")
    assert.equal(c.flags.getValue("missing", 42), 42)
    assert.deepEqual(c.flags.getAll(), {
      on: true,
      off: true,
      variant: "control",
    })
  })

  test("anonymous clients get defaults", async () => {
    const c = client()
    await c.flags.refresh()
    assert.equal(c.flags.isEnabled("off"), false)
  })

  test("store notifies subscribers; concurrent loads share a request", async () => {
    let calls = 0
    const c = createAuthClient({
      baseURL: BASE_URL,
      fetchOptions: {
        customFetchImpl: async (input, init) => {
          calls++
          return auth.handler(new Request(input, init))
        },
      },
      plugins: [featureFlagsClient()],
    })
    const seen: unknown[] = []
    const off = c.flags.store.subscribe((s) => seen.push(s.flags.on))
    await Promise.all([c.flags.load(), c.flags.load()])
    off()
    assert.equal(calls, 1)
    assert.deepEqual(seen, [true])
  })

  test("errors keep the previous flags and record the error", async () => {
    const c = createAuthClient({
      baseURL: BASE_URL,
      fetchOptions: {
        customFetchImpl: async () => new Response("nope", { status: 500 }),
      },
      plugins: [featureFlagsClient({ initialFlags: { on: true } })],
    })
    const s = await c.flags.load()
    assert.ok(s.error)
    assert.equal(c.flags.isEnabled("on"), true)
  })

  test("admin endpoints are typed and reachable through the proxy", async () => {
    const { headers: adminH } = await signUp(auth, "admin@example.com", "admin")
    const c = client(adminH)
    const res = await c.flags.admin.list({ query: {} })
    assert.equal(res.error, null)
    assert.equal(res.data?.flags.length, 3)
    const created = await c.flags.admin.create({
      key: "from-client",
      type: "boolean",
      defaultValue: true,
    })
    assert.equal(created.data?.flag.key, "from-client")
  })

  test("initialFlags seed the store without a request", () => {
    const c = client(undefined, { initialFlags: { on: false, x: "y" } })
    assert.equal(c.flags.store.get().loaded, true)
    assert.equal(c.flags.getValue("x", ""), "y")
  })
})

describe("react bindings", () => {
  const Probe = () => {
    const flags = useFlags()
    return createElement(
      "p",
      null,
      `${String(useFlag("theme", "light"))}|${String(useFlagEnabled("on"))}|${String(flags.loaded)}`
    )
  }

  test("hooks read a provided store", () => {
    const store = createFlagsStore({ theme: "dark", on: true })
    const html = renderToString(
      createElement(FlagsProvider, { store }, createElement(Probe))
    )
    assert.match(html, /dark\|true\|true/)
  })

  test("initialFlags seed an unloaded store", () => {
    const store = createFlagsStore()
    const html = renderToString(
      createElement(
        FlagsProvider,
        { store, initialFlags: { theme: "blue" } },
        createElement(Probe)
      )
    )
    assert.match(html, /blue\|false\|true/)
  })

  test("without a provider, hooks use the latest featureFlagsClient", () => {
    auth = makeAuth()
    client(undefined, { initialFlags: { theme: "solar" } })
    const html = renderToString(createElement(Probe))
    assert.match(html, /solar\|false\|true/)
  })

  test("fallbacks are used until a flag is known", () => {
    const html = renderToString(
      createElement(
        FlagsProvider,
        { store: createFlagsStore() },
        createElement(Probe)
      )
    )
    assert.match(html, /light\|false\|false/)
  })
})
