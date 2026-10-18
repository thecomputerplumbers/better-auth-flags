import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { http, signUp, type Auth } from "../test/helpers.ts"

/** Scenarios run against each real database setup. */
export function scenarios(name: string, fresh: () => Promise<Auth>) {
  describe(name, () => {
    test("end to end: flags, overrides, rules, org, audit, delete", async () => {
      const auth = await fresh()
      const admin = await signUp(auth, "admin@example.com", "admin")
      const user = await signUp(auth, "ada@acme.test")

      const created = await http(auth, "/flags/admin/create", {
        headers: admin.headers,
        body: {
          key: "new-nav",
          type: "boolean",
          defaultValue: false,
          description: "New navigation",
        },
      })
      assert.equal(created.status, 200, JSON.stringify(created.body))
      assert.ok(created.body.flag.id)
      await auth.api.createFlag({
        headers: admin.headers,
        body: {
          key: "checkout",
          type: "json",
          defaultValue: { layout: "a", steps: [1, 2] },
          variants: [
            { value: { layout: "b" }, weight: 1 },
            { value: { layout: "c" }, weight: 1 },
          ],
          rolloutPercentage: 0,
        },
      })

      // Unique key is enforced.
      const dup = await http(auth, "/flags/admin/create", {
        headers: admin.headers,
        body: { key: "new-nav", type: "boolean", defaultValue: true },
      })
      assert.equal(dup.status, 400)

      // Org with the user as owner, active.
      const org = await auth.api.createOrganization({
        headers: user.headers,
        body: { name: "Acme", slug: "acme" },
      })
      await auth.api.setActiveOrganization({
        headers: user.headers,
        body: { organizationId: org!.id },
      })

      await auth.api.setFlagOverride({
        headers: admin.headers,
        body: {
          key: "new-nav",
          subjectType: "organization",
          subjectId: org!.id,
          value: true,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      })
      const { rule } = await auth.api.createFlagRule({
        headers: admin.headers,
        body: {
          key: "checkout",
          priority: 1,
          conditions: [
            { attribute: "organization.slug", operator: "in", value: ["acme"] },
            { attribute: "member.role", operator: "eq", value: "owner" },
            {
              attribute: "user.createdAt",
              operator: "gt",
              value: "2020-01-01",
            },
          ],
          value: { layout: "acme" },
        },
      })
      assert.ok(rule.id)

      const boot = await http(auth, "/flags/bootstrap", {
        headers: user.headers,
      })
      assert.equal(boot.status, 200)
      assert.deepEqual(boot.body.flags, {
        "new-nav": true,
        checkout: { layout: "acme" },
      })
      const anon = await http(auth, "/flags/bootstrap")
      assert.deepEqual(anon.body.flags, {
        "new-nav": false,
        checkout: { layout: "a", steps: [1, 2] },
      })

      // Rollout to 100% gives signed-in users without an org rule a variant.
      await auth.api.updateFlag({
        headers: admin.headers,
        body: { key: "checkout", rolloutPercentage: 100 },
      })
      const adminBoot = await auth.api.bootstrapFlags({
        headers: admin.headers,
      })
      assert.ok(
        ["b", "c"].includes(
          (adminBoot.flags.checkout as { layout: string }).layout
        )
      )

      const got = await auth.api.getFlag({ query: { key: "new-nav" } })
      assert.equal(got.overrides.length, 1)
      assert.ok(got.overrides[0]!.expiresAt instanceof Date)
      assert.equal(got.flag.description, "New navigation")

      await auth.api.deleteFlag({
        headers: admin.headers,
        body: { key: "new-nav" },
      })
      const ctx = await auth.$context
      assert.equal(await ctx.adapter.count({ model: "featureFlagOverride" }), 0)

      const audit = await auth.api.listFlagAudit({
        headers: admin.headers,
        query: { limit: 100 },
      })
      assert.equal(audit.total, 6)
      const byFlag = await auth.api.listFlagAudit({
        headers: admin.headers,
        query: { flagKey: "new-nav" },
      })
      assert.deepEqual(byFlag.entries.map((e) => e.action).sort(), [
        "flag.create",
        "flag.delete",
        "override.set",
      ])
      for (const e of audit.entries) assert.equal(e.actorId, admin.userId)
      const upd = audit.entries.find((e) => e.action === "flag.update")!
      assert.equal(
        (upd.before as { rolloutPercentage: number }).rolloutPercentage,
        0
      )
      assert.equal(
        (upd.after as { rolloutPercentage: number }).rolloutPercentage,
        100
      )

      // Admin endpoints stay closed to the org owner.
      const denied = await http(auth, "/flags/admin/list", {
        headers: user.headers,
      })
      assert.equal(denied.status, 403)
    })

    test("rules update and delete; archived flags drop out of bootstrap", async () => {
      const auth = await fresh()
      const user = await signUp(auth, "u@example.com")
      await auth.api.createFlag({
        body: { key: "n", type: "number", defaultValue: 1 },
      })
      const { rule } = await auth.api.createFlagRule({
        body: {
          key: "n",
          conditions: [
            {
              attribute: "user.email",
              operator: "endsWith",
              value: "@example.com",
            },
          ],
          value: 2,
          rolloutPercentage: 100,
        },
      })
      assert.equal(
        (await auth.api.bootstrapFlags({ headers: user.headers })).flags.n,
        2
      )
      await auth.api.updateFlagRule({ body: { id: rule.id, value: 3 } })
      assert.equal(
        (await auth.api.bootstrapFlags({ headers: user.headers })).flags.n,
        3
      )
      await auth.api.deleteFlagRule({ body: { id: rule.id } })
      assert.equal(
        (await auth.api.bootstrapFlags({ headers: user.headers })).flags.n,
        1
      )
      await auth.api.updateFlag({ body: { key: "n", archived: true } })
      assert.deepEqual(
        (await auth.api.bootstrapFlags({ headers: user.headers })).flags,
        {}
      )
    })
  })
}
