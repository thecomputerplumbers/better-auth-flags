import { bucket } from "./bucket.ts"
import type {
  Condition,
  EvaluationContext,
  Evaluation,
  Flag,
  FlagValue,
  Override,
  Rule,
} from "./types.ts"

export interface EvaluateInput {
  flag: Flag | null | undefined
  overrides?: Override[]
  rules?: Rule[]
  context: EvaluationContext
  /** Returned when the flag does not exist. Defaults to `null`. */
  fallback?: FlagValue
}

/**
 * Evaluates a flag. Pure: no I/O, no clock unless `context.now` is omitted.
 *
 * Order: missing/disabled → user override → organization override →
 * targeting rules (ascending priority) → percentage rollout → default.
 */
export function evaluate(input: EvaluateInput): Evaluation {
  const { flag, context } = input
  if (!flag) return { value: input.fallback ?? null, reason: "missing" }
  if (!flag.enabled || flag.archived)
    return { value: flag.defaultValue, reason: "disabled" }

  const now = (context.now ?? new Date()).getTime()
  const live = (o: Override) =>
    !o.expiresAt || new Date(o.expiresAt).getTime() > now
  const overrides = (input.overrides ?? []).filter(live)

  const userId = context.user?.id
  if (userId) {
    const o = overrides.find(
      (o) => o.subjectType === "user" && o.subjectId === userId
    )
    if (o) return { value: o.value, reason: "user_override" }
  }
  const orgId = context.organization?.id
  if (orgId) {
    const o = overrides.find(
      (o) => o.subjectType === "organization" && o.subjectId === orgId
    )
    if (o) return { value: o.value, reason: "org_override" }
  }

  const subject = flag.rolloutBy === "organization" ? orgId : userId
  const rules = [...(input.rules ?? [])]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority)
  for (const rule of rules) {
    if (!rule.conditions.every((c) => matches(c, context))) continue
    if (rule.rolloutPercentage != null) {
      if (!subject || !inRollout(flag.key, subject, rule.rolloutPercentage))
        continue
    }
    const value =
      rule.value !== undefined
        ? rule.value
        : flag.type === "boolean"
          ? true
          : flag.defaultValue
    return rule.id
      ? { value, reason: "rule", ruleId: rule.id }
      : { value, reason: "rule" }
  }

  if (subject) {
    const pct = flag.rolloutPercentage
    const variants = flag.variants?.filter((v) => v.weight > 0)
    if (variants && variants.length > 0) {
      if (pct == null || inRollout(flag.key, subject, pct))
        return {
          value: pickVariant(flag.key, subject, variants),
          reason: "rollout",
        }
    } else if (pct != null && inRollout(flag.key, subject, pct)) {
      return {
        value: flag.type === "boolean" ? true : flag.defaultValue,
        reason: "rollout",
      }
    }
  }

  return { value: flag.defaultValue, reason: "default" }
}

/** True when the subject's bucket falls under `percentage` (0–100). */
export function inRollout(
  flagKey: string,
  subjectId: string,
  percentage: number
): boolean {
  return bucket(flagKey, subjectId) < Math.round(percentage * 100)
}

/**
 * Picks a variant by cumulative weight. Uses a separate hash input from the
 * rollout bucket, so widening the rollout doesn't reshuffle variants.
 */
export function pickVariant(
  flagKey: string,
  subjectId: string,
  variants: { value: FlagValue; weight: number }[]
): FlagValue {
  const total = variants.reduce((sum, v) => sum + v.weight, 0)
  const point = (bucket(`${flagKey}:variant`, subjectId) / 10000) * total
  let acc = 0
  for (const v of variants) {
    acc += v.weight
    if (point < acc) return v.value
  }
  return variants[variants.length - 1]!.value
}

export function resolveAttribute(
  attribute: string,
  context: EvaluationContext
): unknown {
  const { user, organization, member } = context
  switch (attribute) {
    case "user.id":
      return user?.id
    case "user.email":
      return user?.email ?? undefined
    case "user.emailDomain": {
      const email = user?.email
      const at = email?.lastIndexOf("@") ?? -1
      return email && at >= 0 ? email.slice(at + 1).toLowerCase() : undefined
    }
    case "user.role":
      return user?.role ?? undefined
    case "user.createdAt":
      return user?.createdAt ?? undefined
    case "organization.id":
      return organization?.id
    case "organization.slug":
      return organization?.slug ?? undefined
    case "member.role":
      return member?.role ?? undefined
  }
  if (attribute.startsWith("custom."))
    return context.custom?.[attribute.slice("custom.".length)]
  return undefined
}

function comparable(v: unknown): number | string | undefined {
  if (v instanceof Date) return v.getTime()
  if (typeof v === "number") return v
  if (typeof v === "string") {
    if (v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v)
    const t = Date.parse(v)
    return Number.isNaN(t) ? v : t
  }
  return undefined
}

function asString(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return undefined
}

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof Date) a = a.getTime()
  if (b instanceof Date) b = b.getTime()
  return a === b
}

/** Whether one condition holds. A missing attribute never matches, except `neq`/`notIn`. */
export function matches(c: Condition, context: EvaluationContext): boolean {
  const actual = resolveAttribute(c.attribute, context)
  const missing = actual === undefined || actual === null
  // Roles may be comma-separated ("admin,support").
  const values =
    typeof actual === "string" && c.attribute.endsWith(".role")
      ? actual.split(",").map((s) => s.trim())
      : [actual]
  const expected = c.value
  switch (c.operator) {
    case "eq":
      return !missing && values.some((v) => equal(v, expected))
    case "neq":
      return missing || !values.some((v) => equal(v, expected))
    case "in":
      return (
        !missing &&
        Array.isArray(expected) &&
        values.some((v) => expected.some((e) => equal(v, e)))
      )
    case "notIn":
      return (
        missing ||
        !Array.isArray(expected) ||
        !values.some((v) => expected.some((e) => equal(v, e)))
      )
    case "contains":
    case "startsWith":
    case "endsWith": {
      const s = asString(actual)
      const e = asString(expected)
      if (s === undefined || e === undefined) return false
      return c.operator === "contains"
        ? s.includes(e)
        : c.operator === "startsWith"
          ? s.startsWith(e)
          : s.endsWith(e)
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = comparable(actual)
      const e = comparable(expected)
      if (a === undefined || e === undefined || typeof a !== typeof e)
        return false
      return c.operator === "gt"
        ? a > e
        : c.operator === "gte"
          ? a >= e
          : c.operator === "lt"
            ? a < e
            : a <= e
    }
  }
  return false
}
