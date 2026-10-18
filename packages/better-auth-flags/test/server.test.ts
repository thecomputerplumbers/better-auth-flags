import assert from "node:assert/strict"
import { beforeEach, describe, test } from "node:test"
import { featureFlags } from "../src/server.ts"
import { http, makeAuth, signUp, type Auth } from "./helpers.ts"

// Audit rows sort by createdAt; keep consecutive writes in distinct milliseconds.
const tick = () => new Promise((r) => setTimeout(r, 3))

let auth: Auth
let adminH: Headers
let adminId: string
let userH: Headers
let userId: string

async function setup(opts?: Parameters<typeof makeAuth>[0]) {
  auth = makeAuth(opts)
  ;({ headers: adminH, userId: adminId } = await signUp(
    auth,
    "admin@example.com",
    "admin"
  ))
  ;({ headers: userH, userId } = await signUp(auth, "ada@acme.test"))
}

describe("server plugin (memory adapter)", () => {
  beforeEach(() => setup())

  test("bootstrap is empty with no flags, anonymous or signed in", async () => {
    assert.deepEqual(
      (await auth.api.bootstrapFlags({ headers: userH })).flags,
      {}
    )
    const anon = await http(auth, "/flags/bootstrap")
    assert.equal(anon.status, 200)
    assert.deepEqual(anon.body.flags, {})
  })

  test("admins create flags; bootstrap evaluates them for the session", async () => {
    await auth.api.createFlag({
      headers: adminH,
      body: { key: "new-nav", type: "boolean", defaultValue: false },
    })
    await auth.api.createFlag({
      headers: adminH,
      body: { key: "theme", type: "string", defaultValue: "light" },
    })
    await auth.api.setFlagOverride({
      headers: adminH,
      body: {
        key: "new-nav",
        subjectType: "user",
        subjectId: userId,
        value: true,
      },
    })
    const r = await http(auth, "/flags/bootstrap", { headers: userH })
    assert.deepEqual(r.body.flags, { "new-nav": true, theme: "light" })
    assert.ok(r.body.evaluatedAt)
    const anon = await http(auth, "/flags/bootstrap")
    assert.deepEqual(anon.body.flags, { "new-nav": false, theme: "light" })
  })

  test("evaluate, evaluate-batch and is-enabled", async () => {
    await auth.api.createFlag({
      headers: adminH,
      body: { key: "f", type: "boolean", defaultValue: true },
    })
    const one = await auth.api.evaluateFlag({
      headers: userH,
      query: { key: "f" },
    })
    assert.deepEqual(one, { key: "f", value: true, reason: "default" })
    const missing = await auth.api.evaluateFlag({ query: { key: "nope" } })
    assert.equal(missing.reason, "missing")
    const batch = await http(auth, "/flags/evaluate-batch", {
      headers: userH,
      body: { keys: ["f", "nope", "f"] },
    })
    assert.deepEqual(batch.body.flags, { f: true, nope: null })
    assert.deepEqual(
      await auth.api.isFlagEnabled({ headers: userH, query: { key: "f" } }),
      { enabled: true }
    )
  })

  test("non-admins and anonymous callers get 403/401 from admin endpoints", async () => {
    const body = { key: "x", type: "boolean", defaultValue: false }
    const asUser = await http(auth, "/flags/admin/create", {
      headers: userH,
      body,
    })
    assert.equal(asUser.status, 403)
    assert.equal(asUser.body.code, "FEATURE_FLAGS_FORBIDDEN")
    const anon = await http(auth, "/flags/admin/create", { body })
    assert.equal(anon.status, 401)
    for (const path of ["/flags/admin/list", "/flags/admin/audit"])
      assert.equal((await http(auth, path, { headers: userH })).status, 403)
    const asAdmin = await http(auth, "/flags/admin/create", {
      headers: adminH,
      body,
    })
    assert.equal(asAdmin.status, 200)
  })

  test("org roles never grant access", async () => {
    const org = await auth.api.createOrganization({
      headers: userH,
      body: { name: "Acme", slug: "acme" },
    })
    assert.ok(org)
    const r = await http(auth, "/flags/admin/list", { headers: userH })
    assert.equal(r.status, 403)
  })

  test("server-side calls without headers are trusted, with a null actor", async () => {
    await auth.api.createFlag({
      body: { key: "srv", type: "boolean", defaultValue: false },
    })
    const { entries } = await auth.api.listFlagAudit({})
    assert.equal(entries[0]!.actorId, null)
  })

  test("validates keys and values against the flag type", async () => {
    const bad = [
      { key: "a", type: "boolean", defaultValue: "yes" },
      { key: "b", type: "number", defaultValue: "1" },
      { key: "bad key", type: "boolean", defaultValue: false },
      {
        key: "c",
        type: "string",
        defaultValue: "x",
        variants: [{ value: 1, weight: 1 }],
      },
      {
        key: "d",
        type: "boolean",
        defaultValue: false,
        rolloutPercentage: 101,
      },
    ]
    for (const body of bad)
      assert.equal(
        (await http(auth, "/flags/admin/create", { headers: adminH, body }))
          .status,
        400,
        JSON.stringify(body)
      )
    await auth.api.createFlag({
      body: { key: "n", type: "number", defaultValue: 1 },
    })
    const dup = await http(auth, "/flags/admin/create", {
      headers: adminH,
      body: { key: "n", type: "number", defaultValue: 2 },
    })
    assert.equal(dup.status, 400)
    assert.equal(dup.body.code, "FLAG_EXISTS")
    const ov = await http(auth, "/flags/admin/override/set", {
      headers: adminH,
      body: { key: "n", subjectType: "user", subjectId: "u", value: "1" },
    })
    assert.equal(ov.status, 400)
    const nf = await http(auth, "/flags/admin/get?key=zzz", { headers: adminH })
    assert.equal(nf.status, 404)
  })

  test("update, archive, list and get", async () => {
    await auth.api.createFlag({
      body: {
        key: "f",
        type: "boolean",
        defaultValue: false,
        description: "d",
      },
    })
    const { flag } = await auth.api.updateFlag({
      headers: adminH,
      body: { key: "f", defaultValue: true, rolloutPercentage: 50 },
    })
    assert.equal(flag.defaultValue, true)
    assert.equal(flag.rolloutPercentage, 50)
    assert.equal(flag.description, "d")
    await auth.api.updateFlag({ body: { key: "f", archived: true } })
    assert.deepEqual((await auth.api.listFlags({ query: {} })).flags, [])
    const all = await auth.api.listFlags({ query: { includeArchived: "true" } })
    assert.equal(all.flags.length, 1)
    assert.equal(all.flags[0]!.archived, true)
    assert.deepEqual(
      (await auth.api.bootstrapFlags({ headers: userH })).flags,
      {}
    )
    const ev = await auth.api.evaluateFlag({
      headers: userH,
      query: { key: "f" },
    })
    assert.equal(ev.reason, "disabled")
    await auth.api.updateFlag({ body: { key: "f", archived: false } })
    const got = await auth.api.getFlag({ query: { key: "f" } })
    assert.equal(got.flag.archived, false)
    assert.deepEqual(got.overrides, [])
    assert.deepEqual(got.rules, [])
  })

  test("rules: create, update, delete, ordered by priority", async () => {
    await auth.api.createFlag({
      body: { key: "f", type: "string", defaultValue: "off" },
    })
    const { rule: r1 } = await auth.api.createFlagRule({
      headers: adminH,
      body: {
        key: "f",
        priority: 10,
        conditions: [
          { attribute: "user.emailDomain", operator: "eq", value: "acme.test" },
        ],
        value: "acme",
      },
    })
    const { rule: r2 } = await auth.api.createFlagRule({
      body: { key: "f", priority: 20, conditions: [], value: "everyone" },
    })
    const ev = () =>
      auth.api.evaluateFlag({ headers: userH, query: { key: "f" } })
    assert.deepEqual(await ev(), {
      key: "f",
      value: "acme",
      reason: "rule",
      ruleId: r1.id,
    })
    await auth.api.updateFlagRule({ body: { id: r2.id, priority: 1 } })
    assert.equal((await ev()).value, "everyone")
    await auth.api.updateFlagRule({ body: { id: r2.id, enabled: false } })
    assert.equal((await ev()).value, "acme")
    await auth.api.deleteFlagRule({ headers: adminH, body: { id: r1.id } })
    assert.equal((await ev()).reason, "default")
    const got = await auth.api.getFlag({ query: { key: "f" } })
    assert.equal(got.rules.length, 1)
    const badRule = await http(auth, "/flags/admin/rule/create", {
      headers: adminH,
      body: {
        key: "f",
        conditions: [{ attribute: "x", operator: "eq", value: 1 }],
      },
    })
    assert.equal(badRule.status, 400)
    const missing = await http(auth, "/flags/admin/rule/delete", {
      headers: adminH,
      body: { id: "nope" },
    })
    assert.equal(missing.status, 404)
  })

  test("overrides: set replaces, remove, expiry, list", async () => {
    await auth.api.createFlag({
      body: { key: "f", type: "boolean", defaultValue: false },
    })
    const set = (value: boolean, expiresAt?: string) =>
      auth.api.setFlagOverride({
        headers: adminH,
        body: {
          key: "f",
          subjectType: "user",
          subjectId: userId,
          value,
          ...(expiresAt ? { expiresAt } : {}),
        },
      })
    await set(true)
    await set(false)
    const list = await auth.api.listFlagOverrides({ query: { key: "f" } })
    assert.equal(list.overrides.length, 1)
    assert.equal(list.overrides[0]!.value, false)
    assert.equal(list.overrides[0]!.createdBy, adminId)
    await set(true, "2000-01-01T00:00:00Z")
    const ev = await auth.api.evaluateFlag({
      headers: userH,
      query: { key: "f" },
    })
    assert.equal(ev.reason, "default")
    const rm = await auth.api.removeFlagOverride({
      body: { key: "f", subjectType: "user", subjectId: userId },
    })
    assert.equal(rm.success, true)
    const again = await auth.api.removeFlagOverride({
      body: { key: "f", subjectType: "user", subjectId: userId },
    })
    assert.equal(again.success, false)
  })

  test("delete removes the flag, its overrides and rules", async () => {
    await auth.api.createFlag({
      body: { key: "f", type: "boolean", defaultValue: true },
    })
    await auth.api.setFlagOverride({
      body: { key: "f", subjectType: "user", subjectId: userId, value: false },
    })
    await auth.api.createFlagRule({ body: { key: "f", conditions: [] } })
    await auth.api.deleteFlag({ headers: adminH, body: { key: "f" } })
    const ctx = await auth.$context
    for (const model of [
      "featureFlag",
      "featureFlagOverride",
      "featureFlagRule",
    ])
      assert.equal(await ctx.adapter.count({ model }), 0, model)
    assert.equal(
      (await auth.api.evaluateFlag({ headers: userH, query: { key: "f" } }))
        .reason,
      "missing"
    )
  })

  test("audit log records who, what, before/after, newest first, filterable", async () => {
    await tick()
    await auth.api.createFlag({
      headers: adminH,
      body: { key: "f", type: "boolean", defaultValue: false },
    })
    await tick()
    await auth.api.updateFlag({
      headers: adminH,
      body: { key: "f", enabled: false },
    })
    await tick()
    await auth.api.setFlagOverride({
      headers: adminH,
      body: {
        key: "f",
        subjectType: "organization",
        subjectId: "o1",
        value: true,
      },
    })
    await tick()
    const { rule } = await auth.api.createFlagRule({
      headers: adminH,
      body: { key: "f", conditions: [] },
    })
    await tick()
    await auth.api.updateFlagRule({
      headers: adminH,
      body: { id: rule.id, priority: 5 },
    })
    await tick()
    await auth.api.deleteFlagRule({ headers: adminH, body: { id: rule.id } })
    await tick()
    await auth.api.removeFlagOverride({
      headers: adminH,
      body: { key: "f", subjectType: "organization", subjectId: "o1" },
    })
    await tick()
    await auth.api.createFlag({
      body: { key: "g", type: "boolean", defaultValue: false },
    })
    await tick()
    await auth.api.deleteFlag({ headers: adminH, body: { key: "f" } })

    const res = await http(auth, "/flags/admin/audit?flagKey=f", {
      headers: adminH,
    })
    assert.equal(res.status, 200)
    const actions = res.body.entries.map((e: { action: string }) => e.action)
    assert.deepEqual(actions, [
      "flag.delete",
      "override.remove",
      "rule.delete",
      "rule.update",
      "rule.create",
      "override.set",
      "flag.update",
      "flag.create",
    ])
    assert.equal(res.body.total, 8)
    const upd = res.body.entries.find(
      (e: { action: string }) => e.action === "flag.update"
    )
    assert.equal(upd.actorId, adminId)
    assert.equal(upd.before.enabled, true)
    assert.equal(upd.after.enabled, false)
    const ruleUpd = res.body.entries.find(
      (e: { action: string }) => e.action === "rule.update"
    )
    assert.equal(ruleUpd.before.priority, 0)
    assert.equal(ruleUpd.after.priority, 5)
    const del = res.body.entries[0]
    assert.equal(del.after, null)
    assert.equal(del.before.key, "f")

    const page = await auth.api.listFlagAudit({
      query: { limit: 2, offset: 1 },
    })
    assert.equal(page.entries.length, 2)
    assert.equal(page.total, 9)
    const byActor = await auth.api.listFlagAudit({
      query: { actorId: adminId },
    })
    assert.equal(byActor.total, 8)
  })

  test("organization: active org feeds org overrides, rollouts and conditions", async () => {
    const org = await auth.api.createOrganization({
      headers: userH,
      body: { name: "Acme", slug: "acme" },
    })
    await auth.api.setActiveOrganization({
      headers: userH,
      body: { organizationId: org!.id },
    })
    await auth.api.createFlag({
      body: { key: "org", type: "boolean", defaultValue: false },
    })
    await auth.api.setFlagOverride({
      body: {
        key: "org",
        subjectType: "organization",
        subjectId: org!.id,
        value: true,
      },
    })
    await auth.api.createFlag({
      body: { key: "slug", type: "string", defaultValue: "no" },
    })
    await auth.api.createFlagRule({
      body: {
        key: "slug",
        conditions: [
          { attribute: "organization.slug", operator: "eq", value: "acme" },
          { attribute: "member.role", operator: "eq", value: "owner" },
        ],
        value: "yes",
      },
    })
    await auth.api.createFlag({
      body: {
        key: "byorg",
        type: "boolean",
        defaultValue: false,
        rolloutBy: "organization",
        rolloutPercentage: 100,
      },
    })
    const r = await auth.api.bootstrapFlags({ headers: userH })
    assert.deepEqual(r.flags, { org: true, slug: "yes", byorg: true })
    const other = await auth.api.bootstrapFlags({ headers: adminH })
    assert.deepEqual(other.flags, { org: false, slug: "no", byorg: false })
  })

  test("organization: false ignores the active org", async () => {
    const auth2 = makeAuth({ organization: false, cache: { ttlSeconds: 0 } })
    const { headers } = await signUp(auth2, "x@acme.test")
    const org = await auth2.api.createOrganization({
      headers,
      body: { name: "Acme", slug: "acme" },
    })
    await auth2.api.setActiveOrganization({
      headers,
      body: { organizationId: org!.id },
    })
    await auth2.api.createFlag({
      body: { key: "f", type: "boolean", defaultValue: false },
    })
    await auth2.api.setFlagOverride({
      body: {
        key: "f",
        subjectType: "organization",
        subjectId: org!.id,
        value: true,
      },
    })
    assert.equal((await auth2.api.bootstrapFlags({ headers })).flags.f, false)
  })
})

describe("options", () => {
  test("canManage replaces the admin-role check", async () => {
    await setup({
      cache: { ttlSeconds: 0 },
      canManage: (s) => s.user.email === "ada@acme.test",
    })
    const body = { key: "x", type: "boolean", defaultValue: false }
    assert.equal(
      (await http(auth, "/flags/admin/create", { headers: userH, body }))
        .status,
      200
    )
    assert.equal(
      (
        await http(auth, "/flags/admin/create", {
          headers: adminH,
          body: { ...body, key: "y" },
        })
      ).status,
      403
    )
  })

  test("without the admin plugin or canManage, admin endpoints are closed", async () => {
    const a = makeAuth({ cache: { ttlSeconds: 0 } }, undefined, {
      admin: false,
    })
    const { headers } = await signUp(a, "x@example.com")
    const r = await http(a, "/flags/admin/list", { headers })
    assert.equal(r.status, 403)
  })

  test("context supplies custom attributes", async () => {
    await setup({
      cache: { ttlSeconds: 0 },
      context: (session) => ({ plan: session ? "pro" : "free" }),
    })
    await auth.api.createFlag({
      body: { key: "p", type: "boolean", defaultValue: false },
    })
    await auth.api.createFlagRule({
      body: {
        key: "p",
        conditions: [
          { attribute: "custom.plan", operator: "eq", value: "pro" },
        ],
      },
    })
    assert.equal(
      (await auth.api.bootstrapFlags({ headers: userH })).flags.p,
      true
    )
    assert.equal((await http(auth, "/flags/bootstrap")).body.flags.p, false)
  })

  test("onEvaluate fires per flag and its errors never break evaluation", async () => {
    const events: unknown[] = []
    await setup({
      cache: { ttlSeconds: 0 },
      onEvaluate: (e) => {
        events.push(e)
        throw new Error("boom")
      },
    })
    await auth.api.createFlag({
      body: { key: "a", type: "boolean", defaultValue: true },
    })
    await auth.api.createFlag({
      body: { key: "b", type: "number", defaultValue: 3 },
    })
    const r = await auth.api.bootstrapFlags({ headers: userH })
    assert.deepEqual(r.flags, { a: true, b: 3 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(events, [
      {
        key: "a",
        value: true,
        reason: "default",
        userId,
        organizationId: null,
      },
      { key: "b", value: 3, reason: "default", userId, organizationId: null },
    ])
  })

  test("cache serves stale reads within the TTL, cleared by local admin writes", async () => {
    await setup({ cache: { ttlSeconds: 60 } })
    await auth.api.createFlag({
      body: { key: "c", type: "boolean", defaultValue: false },
    })
    assert.equal(
      (await auth.api.bootstrapFlags({ headers: userH })).flags.c,
      false
    )
    // A write that bypasses the plugin (another instance) is not seen yet.
    const ctx = await auth.$context
    await ctx.adapter.update({
      model: "featureFlag",
      where: [{ field: "key", value: "c" }],
      update: { defaultValue: "true" },
    })
    assert.equal(
      (await auth.api.bootstrapFlags({ headers: userH })).flags.c,
      false
    )
    // A write through the plugin clears it.
    await auth.api.createFlag({
      body: { key: "d", type: "boolean", defaultValue: false },
    })
    assert.equal(
      (await auth.api.bootstrapFlags({ headers: userH })).flags.c,
      true
    )
  })

  test("plugin exposes its schema tables", () => {
    assert.deepEqual(Object.keys(featureFlags().schema), [
      "featureFlag",
      "featureFlagOverride",
      "featureFlagRule",
      "featureFlagAudit",
    ])
  })
})
