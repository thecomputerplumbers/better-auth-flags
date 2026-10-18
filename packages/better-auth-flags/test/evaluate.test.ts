import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { bucket } from "../src/bucket.ts"
import {
  evaluate,
  inRollout,
  matches,
  pickVariant,
  resolveAttribute,
} from "../src/evaluate.ts"
import type { Condition, EvaluationContext, Flag, Rule } from "../src/types.ts"

const boolFlag = (over: Partial<Flag> = {}): Flag => ({
  key: "new-nav",
  type: "boolean",
  enabled: true,
  defaultValue: false,
  rolloutBy: "user",
  ...over,
})
const ctx: EvaluationContext = {
  user: {
    id: "u1",
    email: "Ada@Example.com",
    role: "admin,support",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  },
  organization: { id: "o1", slug: "acme" },
  member: { role: "owner" },
  custom: { plan: "pro", seats: 12 },
}

describe("bucket", () => {
  test("snapshot: changing the hash is a breaking change", () => {
    assert.deepEqual(
      [
        bucket("new-nav", "u1"),
        bucket("new-nav", "u2"),
        bucket("checkout", "o1"),
        bucket("", ""),
      ],
      [615, 8234, 9689, 8253]
    )
  })
})

describe("evaluate precedence", () => {
  test("missing flag returns the fallback", () => {
    assert.deepEqual(evaluate({ flag: null, context: ctx, fallback: 7 }), {
      value: 7,
      reason: "missing",
    })
    assert.deepEqual(evaluate({ flag: undefined, context: ctx }), {
      value: null,
      reason: "missing",
    })
  })

  test("disabled or archived flags serve the default, ignoring overrides", () => {
    const overrides = [
      { subjectType: "user" as const, subjectId: "u1", value: true },
    ]
    for (const flag of [
      boolFlag({ enabled: false }),
      boolFlag({ archived: true }),
    ])
      assert.deepEqual(evaluate({ flag, overrides, context: ctx }), {
        value: false,
        reason: "disabled",
      })
  })

  test("user override beats org override, rules and rollout", () => {
    const r = evaluate({
      flag: boolFlag({ rolloutPercentage: 100 }),
      overrides: [
        { subjectType: "organization", subjectId: "o1", value: true },
        { subjectType: "user", subjectId: "u1", value: false },
      ],
      rules: [{ priority: 0, enabled: true, conditions: [], value: true }],
      context: ctx,
    })
    assert.deepEqual(r, { value: false, reason: "user_override" })
  })

  test("org override beats rules", () => {
    const r = evaluate({
      flag: boolFlag(),
      overrides: [
        { subjectType: "organization", subjectId: "o1", value: true },
        { subjectType: "user", subjectId: "other", value: false },
      ],
      rules: [{ priority: 0, enabled: true, conditions: [], value: false }],
      context: ctx,
    })
    assert.deepEqual(r, { value: true, reason: "org_override" })
  })

  test("expired overrides are ignored", () => {
    const now = new Date("2026-06-01T00:00:00Z")
    const r = evaluate({
      flag: boolFlag(),
      overrides: [
        {
          subjectType: "user",
          subjectId: "u1",
          value: true,
          expiresAt: new Date("2026-05-01T00:00:00Z"),
        },
        {
          subjectType: "organization",
          subjectId: "o1",
          value: true,
          expiresAt: new Date("2026-07-01T00:00:00Z"),
        },
      ],
      context: { ...ctx, now },
    })
    assert.equal(r.reason, "org_override")
  })

  test("rules run by ascending priority, skipping disabled ones", () => {
    const rules: Rule[] = [
      { id: "c", priority: 3, enabled: true, conditions: [], value: "c" },
      { id: "a", priority: 1, enabled: false, conditions: [], value: "a" },
      {
        id: "b",
        priority: 2,
        enabled: true,
        conditions: [
          { attribute: "custom.plan", operator: "eq", value: "pro" },
        ],
        value: "b",
      },
    ]
    const flag: Flag = { ...boolFlag(), type: "string", defaultValue: "x" }
    assert.deepEqual(evaluate({ flag, rules, context: ctx }), {
      value: "b",
      reason: "rule",
      ruleId: "b",
    })
    assert.deepEqual(
      evaluate({ flag, rules, context: { ...ctx, custom: {} } }),
      { value: "c", reason: "rule", ruleId: "c" }
    )
  })

  test("a matching boolean rule without a value serves true", () => {
    const r = evaluate({
      flag: boolFlag(),
      rules: [{ priority: 0, enabled: true, conditions: [] }],
      context: ctx,
    })
    assert.equal(r.value, true)
  })

  test("a non-matching rule falls through to the default", () => {
    const r = evaluate({
      flag: boolFlag(),
      rules: [
        {
          priority: 0,
          enabled: true,
          conditions: [{ attribute: "user.id", operator: "eq", value: "nope" }],
          value: true,
        },
      ],
      context: ctx,
    })
    assert.deepEqual(r, { value: false, reason: "default" })
  })

  test("rule rollout only serves the share in its bucket", () => {
    let on = 0
    for (let i = 0; i < 2000; i++) {
      const r = evaluate({
        flag: boolFlag(),
        rules: [
          { priority: 0, enabled: true, conditions: [], rolloutPercentage: 25 },
        ],
        context: { user: { id: `u${i}` } },
      })
      if (r.value === true) on++
    }
    assert.ok(on > 400 && on < 600, String(on))
  })

  test("boolean rollout: 0% nobody, 100% everybody", () => {
    for (const [pct, want] of [
      [0, false],
      [100, true],
    ] as const) {
      for (let i = 0; i < 200; i++)
        assert.equal(
          evaluate({
            flag: boolFlag({ rolloutPercentage: pct }),
            context: { user: { id: `u${i}` } },
          }).value,
          want
        )
    }
  })

  test("rollout is monotonic: raising the percentage keeps everyone in", () => {
    for (let i = 0; i < 1000; i++) {
      const id = `user-${i}`
      let wasIn = false
      for (let pct = 0; pct <= 100; pct += 5) {
        const isIn = inRollout("k", id, pct)
        if (wasIn) assert.ok(isIn, `${id} dropped at ${pct}`)
        wasIn = isIn
      }
    }
  })

  test("rolloutBy organization hashes the org id", () => {
    const flag = boolFlag({ rolloutBy: "organization", rolloutPercentage: 50 })
    const values = new Set<unknown>()
    for (let i = 0; i < 50; i++)
      values.add(
        evaluate({
          flag,
          context: { user: { id: `u${i}` }, organization: { id: "fixed" } },
        }).value
      )
    assert.equal(values.size, 1)
    assert.deepEqual(evaluate({ flag, context: { user: { id: "u" } } }), {
      value: false,
      reason: "default",
    })
  })

  test("anonymous sessions skip overrides and rollouts", () => {
    const r = evaluate({
      flag: boolFlag({ rolloutPercentage: 100 }),
      overrides: [{ subjectType: "user", subjectId: "u1", value: true }],
      context: {},
    })
    assert.deepEqual(r, { value: false, reason: "default" })
  })

  test("multivariate flags split by weight and stay sticky", () => {
    const flag: Flag = {
      key: "checkout",
      type: "string",
      enabled: true,
      defaultValue: "control",
      rolloutBy: "user",
      variants: [
        { value: "a", weight: 1 },
        { value: "b", weight: 3 },
        { value: "zero", weight: 0 },
      ],
    }
    const counts: Record<string, number> = {}
    for (let i = 0; i < 4000; i++) {
      const v = evaluate({ flag, context: { user: { id: `u${i}` } } })
      assert.equal(v.reason, "rollout")
      counts[String(v.value)] = (counts[String(v.value)] ?? 0) + 1
    }
    assert.equal(counts.zero, undefined)
    assert.ok(counts.a! > 850 && counts.a! < 1150, JSON.stringify(counts))
    const once = evaluate({ flag, context: { user: { id: "sticky" } } })
    const again = evaluate({ flag, context: { user: { id: "sticky" } } })
    assert.deepEqual(once, again)
  })

  test("multivariate rollout percentage gates who gets a variant", () => {
    const flag: Flag = {
      key: "checkout",
      type: "string",
      enabled: true,
      defaultValue: "control",
      rolloutBy: "user",
      rolloutPercentage: 0,
      variants: [{ value: "a", weight: 1 }],
    }
    assert.deepEqual(evaluate({ flag, context: { user: { id: "u" } } }), {
      value: "control",
      reason: "default",
    })
  })

  test("pickVariant returns the last variant at the top edge", () => {
    assert.equal(pickVariant("k", "u", [{ value: 1, weight: 1 }]), 1)
  })
})

describe("conditions", () => {
  const m = (
    attribute: string,
    operator: Condition["operator"],
    value: Condition["value"],
    c = ctx
  ) => matches({ attribute, operator, value }, c)

  test("attributes resolve from the context", () => {
    assert.equal(resolveAttribute("user.emailDomain", ctx), "example.com")
    assert.equal(resolveAttribute("organization.slug", ctx), "acme")
    assert.equal(resolveAttribute("member.role", ctx), "owner")
    assert.equal(resolveAttribute("custom.seats", ctx), 12)
    assert.equal(resolveAttribute("unknown.thing", ctx), undefined)
    assert.equal(resolveAttribute("user.emailDomain", {}), undefined)
  })

  test("eq / neq, with comma-separated roles", () => {
    assert.ok(m("user.role", "eq", "support"))
    assert.ok(m("user.id", "eq", "u1"))
    assert.ok(!m("user.id", "eq", "u2"))
    assert.ok(m("user.id", "neq", "u2"))
    assert.ok(!m("user.role", "neq", "admin"))
    assert.ok(m("user.id", "neq", "u1", {}), "missing attribute is neq")
    assert.ok(!m("user.id", "eq", "u1", {}))
  })

  test("in / notIn", () => {
    assert.ok(m("organization.slug", "in", ["acme", "globex"]))
    assert.ok(!m("organization.slug", "in", ["globex"]))
    assert.ok(!m("organization.slug", "in", "acme"), "non-array never matches")
    assert.ok(m("organization.slug", "notIn", ["globex"]))
    assert.ok(!m("member.role", "notIn", ["owner"]))
    assert.ok(m("member.role", "notIn", ["owner"], {}))
  })

  test("string operators", () => {
    assert.ok(m("user.email", "contains", "@Example"))
    assert.ok(m("user.email", "startsWith", "Ada"))
    assert.ok(m("user.email", "endsWith", ".com"))
    assert.ok(!m("user.email", "endsWith", ".org"))
    assert.ok(!m("user.email", "contains", "x", {}))
    assert.ok(!m("user.email", "contains", ["x"]))
  })

  test("numeric and date comparisons", () => {
    assert.ok(m("custom.seats", "gt", 10))
    assert.ok(m("custom.seats", "gte", 12))
    assert.ok(!m("custom.seats", "lt", 12))
    assert.ok(m("custom.seats", "lte", "12"))
    assert.ok(m("user.createdAt", "lt", "2026-02-01T00:00:00Z"))
    assert.ok(!m("user.createdAt", "gt", "2026-02-01T00:00:00Z"))
    assert.ok(!m("custom.plan", "gt", 1), "mismatched types never match")
    assert.ok(!m("custom.missing", "gt", 1))
    assert.ok(
      m("custom.when", "eq", new Date(5).getTime(), {
        custom: { when: new Date(5) },
      })
    )
  })
})
