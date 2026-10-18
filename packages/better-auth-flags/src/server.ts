import type { BetterAuthPlugin } from "better-auth"
import {
  APIError,
  createAuthEndpoint,
  getSessionFromCtx,
} from "better-auth/api"
import * as z from "zod"
import { evaluate } from "./evaluate.ts"
import { schema } from "./schema.ts"
import {
  OPERATORS,
  type Condition,
  type Evaluation,
  type EvaluationContext,
  type EvaluationReason,
  type Flag,
  type FlagType,
  type FlagValue,
  type Override,
  type Rule,
} from "./types.ts"

type Ctx = Parameters<typeof getSessionFromCtx>[0]
type Session = NonNullable<Awaited<ReturnType<typeof getSessionFromCtx>>>

export interface EvaluateEvent {
  key: string
  value: FlagValue
  reason: EvaluationReason
  userId: string | null
  organizationId: string | null
}

export interface FeatureFlagsOptions {
  /**
   * Use the session's active organization for org overrides, organization
   * rollouts and `organization.*` / `member.role` conditions. Defaults to
   * whether the `organization` plugin is registered.
   */
  organization?: boolean
  /**
   * Who may call the admin endpoints. Replaces the default check (the
   * `admin` plugin's `adminRoles` / `adminUserIds`). Organization roles
   * never grant access.
   */
  canManage?: (session: Session, ctx: Ctx) => boolean | Promise<boolean>
  /** Extra attributes for `custom.<name>` conditions. */
  context?: (
    session: Session | null,
    ctx: Ctx
  ) =>
    | Record<string, FlagValue | Date | undefined>
    | Promise<Record<string, FlagValue | Date | undefined>>
  /**
   * Called once per evaluated flag, fire-and-forget. Errors are logged and
   * never change the result.
   */
  onEvaluate?: (event: EvaluateEvent, ctx: Ctx) => void | Promise<void>
  /**
   * In-process cache of flags and rules. Admin changes made through this
   * instance clear it immediately; other instances see them within the TTL.
   * Default 30 seconds; 0 disables it.
   */
  cache?: { ttlSeconds?: number }
}

// ---------- rows and parsing ----------

interface FlagRow {
  id: string
  key: string
  type: string
  description?: string | null
  enabled: boolean
  defaultValue: string
  variants?: string | null
  rolloutPercentage?: number | null
  rolloutBy: string
  archivedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}
interface OverrideRow {
  id: string
  flagId: string
  subjectType: string
  subjectId: string
  value: string
  expiresAt?: Date | null
  createdBy?: string | null
  createdAt: Date
  updatedAt: Date
}
interface RuleRow {
  id: string
  flagId: string
  priority: number
  enabled: boolean
  conditions: string
  value?: string | null
  rolloutPercentage?: number | null
  createdAt: Date
  updatedAt: Date
}
interface AuditRow {
  id: string
  flagId?: string | null
  flagKey: string
  action: string
  actorId?: string | null
  before?: string | null
  after?: string | null
  createdAt: Date
}

const parse = (s: string | null | undefined): FlagValue | undefined =>
  s == null ? undefined : (JSON.parse(s) as FlagValue)
const num = (n: unknown) => (n == null ? null : Number(n))

export function toFlag(row: FlagRow) {
  return {
    id: row.id,
    key: row.key,
    type: row.type as FlagType,
    description: row.description ?? null,
    enabled: Boolean(row.enabled),
    archived: row.archivedAt != null,
    archivedAt: row.archivedAt ?? null,
    defaultValue: parse(row.defaultValue) ?? null,
    variants: (parse(row.variants) as Flag["variants"]) ?? null,
    rolloutPercentage: num(row.rolloutPercentage),
    rolloutBy: row.rolloutBy as Flag["rolloutBy"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
export function toOverride(row: OverrideRow) {
  return {
    id: row.id,
    flagId: row.flagId,
    subjectType: row.subjectType as Override["subjectType"],
    subjectId: row.subjectId,
    value: parse(row.value) ?? null,
    expiresAt: row.expiresAt ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
export function toRule(row: RuleRow) {
  const value = parse(row.value)
  return {
    id: row.id,
    flagId: row.flagId,
    priority: Number(row.priority),
    enabled: Boolean(row.enabled),
    conditions: (parse(row.conditions) ?? []) as unknown as Condition[],
    ...(value !== undefined ? { value } : {}),
    rolloutPercentage: num(row.rolloutPercentage),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
function toAudit(row: AuditRow) {
  return {
    id: row.id,
    flagId: row.flagId ?? null,
    flagKey: row.flagKey,
    action: row.action,
    actorId: row.actorId ?? null,
    before: parse(row.before) ?? null,
    after: parse(row.after) ?? null,
    createdAt: row.createdAt,
  }
}

// ---------- validation ----------

const flagValue: z.ZodType<FlagValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.string(),
    z.number(),
    z.null(),
    z.array(flagValue),
    z.record(z.string(), flagValue),
  ])
)
const percentage = z.number().int().min(0).max(100)
const flagKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "letters, digits, . _ : -")
const condition = z.object({
  attribute: z.string().regex(/^(user|organization|member|custom)\.[\w.-]+$/),
  operator: z.enum(OPERATORS),
  value: flagValue,
})
const variant = z.object({ value: flagValue, weight: z.number().min(0) })

function checkType(type: FlagType, value: FlagValue, what: string) {
  const ok =
    type === "json" ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "string" && typeof value === "string") ||
    (type === "number" && typeof value === "number" && Number.isFinite(value))
  if (!ok)
    throw new APIError("BAD_REQUEST", {
      message: `${what} must be a ${type}`,
      code: "INVALID_FLAG_VALUE",
    })
}

// ---------- plugin ----------

const MODELS = {
  flag: "featureFlag",
  override: "featureFlagOverride",
  rule: "featureFlagRule",
  audit: "featureFlagAudit",
} as const

export const featureFlags = (options: FeatureFlagsOptions = {}) => {
  const ttl = (options.cache?.ttlSeconds ?? 30) * 1000
  let cached: { at: number; flags: FlagRow[]; rules: RuleRow[] } | null = null
  const invalidate = () => {
    cached = null
  }

  async function loadAll(ctx: Ctx) {
    if (cached && ttl > 0 && Date.now() - cached.at < ttl) return cached
    const adapter = ctx.context.adapter
    const [flags, rules] = await Promise.all([
      adapter.findMany<FlagRow>({ model: MODELS.flag }),
      adapter.findMany<RuleRow>({ model: MODELS.rule }),
    ])
    const fresh = { at: Date.now(), flags, rules }
    if (ttl > 0) cached = fresh
    return fresh
  }

  function orgAware(ctx: Ctx) {
    return (
      options.organization ??
      ctx.context.options.plugins?.some((p) => p.id === "organization") ??
      false
    )
  }

  async function buildContext(
    ctx: Ctx,
    session: Session | null
  ): Promise<EvaluationContext> {
    const evalCtx: EvaluationContext = {}
    if (session) {
      const u = session.user as Session["user"] & { role?: string | null }
      evalCtx.user = {
        id: u.id,
        email: u.email,
        role: u.role ?? null,
        createdAt: u.createdAt,
      }
      const orgId = (
        session.session as { activeOrganizationId?: string | null }
      ).activeOrganizationId
      if (orgId && orgAware(ctx)) {
        const adapter = ctx.context.adapter
        const [org, member] = await Promise.all([
          adapter.findOne<{ id: string; slug?: string | null }>({
            model: "organization",
            where: [{ field: "id", value: orgId }],
          }),
          adapter.findOne<{ role?: string | null }>({
            model: "member",
            where: [
              { field: "organizationId", value: orgId },
              { field: "userId", value: u.id },
            ],
          }),
        ])
        evalCtx.organization = { id: orgId, slug: org?.slug ?? null }
        evalCtx.member = { role: member?.role ?? null }
      }
    }
    if (options.context) evalCtx.custom = await options.context(session, ctx)
    return evalCtx
  }

  /** Evaluates `keys` (or every non-archived flag) for the request. */
  async function evaluateFor(
    ctx: Ctx,
    keys: string[] | null
  ): Promise<Record<string, Evaluation & { key: string }>> {
    const session = await getSessionFromCtx(ctx)
    const [{ flags, rules }, evalCtx] = await Promise.all([
      loadAll(ctx),
      buildContext(ctx, session),
    ])
    const subjects = [evalCtx.user?.id, evalCtx.organization?.id].filter(
      (s): s is string => !!s
    )
    const overrides = subjects.length
      ? await ctx.context.adapter.findMany<OverrideRow>({
          model: MODELS.override,
          where: [{ field: "subjectId", operator: "in", value: subjects }],
        })
      : []
    const byKey = new Map(flags.map((f) => [f.key, f]))
    const wanted =
      keys ?? flags.filter((f) => f.archivedAt == null).map((f) => f.key)
    const out: Record<string, Evaluation & { key: string }> = {}
    for (const key of wanted) {
      const row = byKey.get(key)
      const result = evaluate({
        flag: row ? toFlag(row) : null,
        overrides: row
          ? overrides.filter((o) => o.flagId === row.id).map(toOverride)
          : [],
        rules: row
          ? rules
              .filter((r) => r.flagId === row.id)
              .map((r) => toRule(r) as Rule)
          : [],
        context: evalCtx,
      })
      out[key] = { key, ...result }
      if (options.onEvaluate) {
        const event: EvaluateEvent = {
          key,
          value: result.value,
          reason: result.reason,
          userId: evalCtx.user?.id ?? null,
          organizationId: evalCtx.organization?.id ?? null,
        }
        void Promise.resolve()
          .then(() => options.onEvaluate!(event, ctx))
          .catch((err: unknown) =>
            ctx.context.logger.error("feature-flags: onEvaluate failed", err)
          )
      }
    }
    return out
  }

  /** Resolves the acting admin, or throws. Server calls with no headers are trusted. */
  async function requireAdmin(ctx: Ctx): Promise<{ actorId: string | null }> {
    if (!ctx.request && !ctx.headers) return { actorId: null }
    const session = await getSessionFromCtx(ctx)
    if (!session) throw new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED" })
    let allowed = false
    if (options.canManage) {
      allowed = await options.canManage(session, ctx)
    } else {
      const adminPlugin = ctx.context.options.plugins?.find(
        (p) => p.id === "admin"
      ) as
        | {
            options?: {
              adminRoles?: string | string[]
              adminUserIds?: string[]
            }
          }
        | undefined
      if (adminPlugin) {
        const raw = adminPlugin.options?.adminRoles ?? ["admin"]
        const adminRoles = Array.isArray(raw) ? raw : raw.split(",")
        const roles = String(
          (session.user as { role?: string | null }).role ?? ""
        )
          .split(",")
          .map((r) => r.trim())
        allowed =
          !!adminPlugin.options?.adminUserIds?.includes(session.user.id) ||
          roles.some((r) => adminRoles.includes(r))
      }
    }
    if (!allowed)
      throw new APIError("FORBIDDEN", {
        message: "Not allowed to manage feature flags",
        code: "FEATURE_FLAGS_FORBIDDEN",
      })
    return { actorId: session.user.id }
  }

  async function findFlag(ctx: Ctx, key: string) {
    const row = await ctx.context.adapter.findOne<FlagRow>({
      model: MODELS.flag,
      where: [{ field: "key", value: key }],
    })
    if (!row)
      throw new APIError("NOT_FOUND", {
        message: `Flag ${key} not found`,
        code: "FLAG_NOT_FOUND",
      })
    return row
  }

  async function audit(
    ctx: Ctx,
    entry: {
      flagId: string | null
      flagKey: string
      action: string
      actorId: string | null
      before?: unknown
      after?: unknown
    }
  ) {
    await ctx.context.adapter.create({
      model: MODELS.audit,
      data: {
        flagId: entry.flagId,
        flagKey: entry.flagKey,
        action: entry.action,
        actorId: entry.actorId,
        before:
          entry.before === undefined ? null : JSON.stringify(entry.before),
        after: entry.after === undefined ? null : JSON.stringify(entry.after),
        createdAt: new Date(),
      },
    })
    invalidate()
  }

  const validateFlag = (f: {
    type: FlagType
    defaultValue: FlagValue
    variants?: { value: FlagValue; weight: number }[] | null
  }) => {
    checkType(f.type, f.defaultValue, "defaultValue")
    f.variants?.forEach((v, i) => checkType(f.type, v.value, `variants[${i}]`))
  }

  return {
    id: "feature-flags",
    schema,
    endpoints: {
      // ----- session endpoints -----
      bootstrapFlags: createAuthEndpoint(
        "/flags/bootstrap",
        { method: "GET" },
        async (ctx) => {
          const results = await evaluateFor(ctx, null)
          const flags: Record<string, FlagValue> = {}
          for (const [k, r] of Object.entries(results)) flags[k] = r.value
          return ctx.json({ flags, evaluatedAt: new Date().toISOString() })
        }
      ),
      evaluateFlag: createAuthEndpoint(
        "/flags/evaluate",
        {
          method: "GET",
          query: z.object({ key: z.string().min(1) }),
        },
        async (ctx) => {
          const results = await evaluateFor(ctx, [ctx.query.key])
          return ctx.json(results[ctx.query.key]!)
        }
      ),
      evaluateFlags: createAuthEndpoint(
        "/flags/evaluate-batch",
        {
          method: "POST",
          body: z.object({ keys: z.array(z.string().min(1)).max(500) }),
        },
        async (ctx) => {
          const results = await evaluateFor(ctx, [...new Set(ctx.body.keys)])
          const flags: Record<string, FlagValue> = {}
          for (const [k, r] of Object.entries(results)) flags[k] = r.value
          return ctx.json({ flags })
        }
      ),
      isFlagEnabled: createAuthEndpoint(
        "/flags/is-enabled",
        {
          method: "GET",
          query: z.object({ key: z.string().min(1) }),
        },
        async (ctx) => {
          const results = await evaluateFor(ctx, [ctx.query.key])
          return ctx.json({ enabled: results[ctx.query.key]!.value === true })
        }
      ),

      // ----- admin: flags -----
      createFlag: createAuthEndpoint(
        "/flags/admin/create",
        {
          method: "POST",
          body: z.object({
            key: flagKey,
            type: z.enum(["boolean", "string", "number", "json"]),
            description: z.string().max(1000).optional(),
            enabled: z.boolean().optional(),
            defaultValue: flagValue,
            variants: z.array(variant).max(100).nullish(),
            rolloutPercentage: percentage.nullish(),
            rolloutBy: z.enum(["user", "organization"]).optional(),
          }),
        },
        async (ctx) => {
          const { actorId } = await requireAdmin(ctx)
          const b = ctx.body
          validateFlag(b)
          const existing = await ctx.context.adapter.findOne<FlagRow>({
            model: MODELS.flag,
            where: [{ field: "key", value: b.key }],
          })
          if (existing)
            throw new APIError("BAD_REQUEST", {
              message: `Flag ${b.key} already exists`,
              code: "FLAG_EXISTS",
            })
          const now = new Date()
          const row = await ctx.context.adapter.create<
            Omit<FlagRow, "id">,
            FlagRow
          >({
            model: MODELS.flag,
            data: {
              key: b.key,
              type: b.type,
              description: b.description ?? null,
              enabled: b.enabled ?? true,
              defaultValue: JSON.stringify(b.defaultValue),
              variants: b.variants ? JSON.stringify(b.variants) : null,
              rolloutPercentage: b.rolloutPercentage ?? null,
              rolloutBy: b.rolloutBy ?? "user",
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
            },
          })
          const flag = toFlag(row)
          await audit(ctx, {
            flagId: row.id,
            flagKey: row.key,
            action: "flag.create",
            actorId,
            after: flag,
          })
          return ctx.json({ flag })
        }
      ),
      updateFlag: createAuthEndpoint(
        "/flags/admin/update",
        {
          method: "POST",
          body: z.object({
            key: z.string().min(1),
            description: z.string().max(1000).nullish(),
            enabled: z.boolean().optional(),
            defaultValue: flagValue.optional(),
            variants: z.array(variant).max(100).nullish(),
            rolloutPercentage: percentage.nullish(),
            rolloutBy: z.enum(["user", "organization"]).optional(),
            archived: z.boolean().optional(),
          }),
        },
        async (ctx) => {
          const { actorId } = await requireAdmin(ctx)
          const row = await findFlag(ctx, ctx.body.key)
          const before = toFlag(row)
          const b = ctx.body
          validateFlag({
            type: before.type,
            defaultValue:
              b.defaultValue !== undefined
                ? b.defaultValue
                : before.defaultValue,
            variants: b.variants !== undefined ? b.variants : before.variants,
          })
          const update: Record<string, unknown> = { updatedAt: new Date() }
          if (b.description !== undefined) update.description = b.description
          if (b.enabled !== undefined) update.enabled = b.enabled
          if (b.defaultValue !== undefined)
            update.defaultValue = JSON.stringify(b.defaultValue)
          if (b.variants !== undefined)
            update.variants = b.variants ? JSON.stringify(b.variants) : null
          if (b.rolloutPercentage !== undefined)
            update.rolloutPercentage = b.rolloutPercentage
          if (b.rolloutBy !== undefined) update.rolloutBy = b.rolloutBy
          if (b.archived !== undefined)
            update.archivedAt = b.archived
              ? (row.archivedAt ?? new Date())
              : null
          const updated = await ctx.context.adapter.update<FlagRow>({
            model: MODELS.flag,
            where: [{ field: "id", value: row.id }],
            update,
          })
          const flag = toFlag(updated ?? ({ ...row, ...update } as FlagRow))
          await audit(ctx, {
            flagId: row.id,
            flagKey: row.key,
            action: "flag.update",
            actorId,
            before,
            after: flag,
          })
          return ctx.json({ flag })
        }
      ),
      deleteFlag: createAuthEndpoint(
        "/flags/admin/delete",
        { method: "POST", body: z.object({ key: z.string().min(1) }) },
        async (ctx) => {
          const { actorId } = await requireAdmin(ctx)
          const row = await findFlag(ctx, ctx.body.key)
          const adapter = ctx.context.adapter
          const where = [{ field: "flagId", value: row.id }]
          await adapter.deleteMany({ model: MODELS.override, where })
          await adapter.deleteMany({ model: MODELS.rule, where })
          await adapter.delete({
            model: MODELS.flag,
            where: [{ field: "id", value: row.id }],
          })
          await audit(ctx, {
            flagId: row.id,
            flagKey: row.key,
            action: "flag.delete",
            actorId,
            before: toFlag(row),
          })
          return ctx.json({ success: true })
        }
      ),
      listFlags: createAuthEndpoint(
        "/flags/admin/list",
        {
          method: "GET",
          query: z
            .object({
              includeArchived: z
                .union([z.boolean(), z.enum(["true", "false"])])
                .optional(),
            })
            .optional(),
        },
        async (ctx) => {
          await requireAdmin(ctx)
          const include = String(ctx.query?.includeArchived) === "true"
          const rows = await ctx.context.adapter.findMany<FlagRow>({
            model: MODELS.flag,
            sortBy: { field: "key", direction: "asc" },
          })
          const flags = rows
            .filter((r) => include || r.archivedAt == null)
            .map(toFlag)
          return ctx.json({ flags })
        }
      ),
      getFlag: createAuthEndpoint(
        "/flags/admin/get",
        { method: "GET", query: z.object({ key: z.string().min(1) }) },
        async (ctx) => {
          await requireAdmin(ctx)
          const row = await findFlag(ctx, ctx.query.key)
          const where = [{ field: "flagId", value: row.id }]
          const [overrides, rules] = await Promise.all([
            ctx.context.adapter.findMany<OverrideRow>({
              model: MODELS.override,
              where,
            }),
            ctx.context.adapter.findMany<RuleRow>({
              model: MODELS.rule,
              where,
              sortBy: { field: "priority", direction: "asc" },
            }),
          ])
          return ctx.json({
            flag: toFlag(row),
            overrides: overrides.map(toOverride),
            rules: rules.map(toRule),
          })
        }
      ),

      // ----- admin: overrides -----
      setFlagOverride: createAuthEndpoint(
        "/flags/admin/override/set",
        {
          method: "POST",
          body: z.object({
            key: z.string().min(1),
            subjectType: z.enum(["user", "organization"]),
            subjectId: z.string().min(1),
            value: flagValue,
            expiresAt: z.coerce.date().nullish(),
          }),
        },
        async (ctx) => {
          const { actorId } = await requireAdmin(ctx)
          const b = ctx.body
          const flag = await findFlag(ctx, b.key)
          checkType(flag.type as FlagType, b.value, "value")
          const adapter = ctx.context.adapter
          const where = [
            { field: "flagId", value: flag.id },
            { field: "subjectType", value: b.subjectType },
            { field: "subjectId", value: b.subjectId },
          ]
          const existing = await adapter.findOne<OverrideRow>({
            model: MODELS.override,
            where,
          })
          const now = new Date()
          const data = {
            value: JSON.stringify(b.value),
            expiresAt: b.expiresAt ?? null,
            createdBy: actorId,
            updatedAt: now,
          }
          const row = existing
            ? ((await adapter.update<OverrideRow>({
                model: MODELS.override,
                where: [{ field: "id", value: existing.id }],
                update: data,
              })) ?? { ...existing, ...data })
            : await adapter.create<Omit<OverrideRow, "id">, OverrideRow>({
                model: MODELS.override,
                data: {
                  flagId: flag.id,
                  subjectType: b.subjectType,
                  subjectId: b.subjectId,
                  createdAt: now,
                  ...data,
                },
              })
          const override = toOverride(row)
          await audit(ctx, {
            flagId: flag.id,
            flagKey: flag.key,
            action: "override.set",
            actorId,
            ...(existing ? { before: toOverride(existing) } : {}),
            after: override,
          })
          return ctx.json({ override })
        }
      ),
      removeFlagOverride: createAuthEndpoint(
        "/flags/admin/override/remove",
        {
          method: "POST",
          body: z.object({
            key: z.string().min(1),
            subjectType: z.enum(["user", "organization"]),
            subjectId: z.string().min(1),
          }),
        },
        async (ctx) => {
          const { actorId } = await requireAdmin(ctx)
          const b = ctx.body
          const flag = await findFlag(ctx, b.key)
          const existing = await ctx.context.adapter.findOne<OverrideRow>({
            model: MODELS.override,
            where: [
              { field: "flagId", value: flag.id },
              { field: "subjectType", value: b.subjectType },
              { field: "subjectId", value: b.subjectId },
            ],
          })
          if (!existing) return ctx.json({ success: false })
          await ctx.context.adapter.delete({
            model: MODELS.override,
            where: [{ field: "id", value: existing.id }],
          })
          await audit(ctx, {
            flagId: flag.id,
            flagKey: flag.key,
            action: "override.remove",
            actorId,
            before: toOverride(existing),
          })
          return ctx.json({ success: true })
        }
      ),
      listFlagOverrides: createAuthEndpoint(
        "/flags/admin/override/list",
        { method: "GET", query: z.object({ key: z.string().min(1) }) },
        async (ctx) => {
          await requireAdmin(ctx)
          const flag = await findFlag(ctx, ctx.query.key)
          const rows = await ctx.context.adapter.findMany<OverrideRow>({
            model: MODELS.override,
            where: [{ field: "flagId", value: flag.id }],
          })
          return ctx.json({ overrides: rows.map(toOverride) })
        }
      ),

      // ----- admin: rules -----
      createFlagRule: createAuthEndpoint(
        "/flags/admin/rule/create",
        {
          method: "POST",
          body: z.object({
            key: z.string().min(1),
            priority: z.number().int().optional(),
            enabled: z.boolean().optional(),
            conditions: z.array(condition).max(50),
            value: flagValue.optional(),
            rolloutPercentage: percentage.nullish(),
          }),
        },
        async (ctx) => {
          const { actorId } = await requireAdmin(ctx)
          const b = ctx.body
          const flag = await findFlag(ctx, b.key)
          if (b.value !== undefined)
            checkType(flag.type as FlagType, b.value, "value")
          const now = new Date()
          const row = await ctx.context.adapter.create<
            Omit<RuleRow, "id">,
            RuleRow
          >({
            model: MODELS.rule,
            data: {
              flagId: flag.id,
              priority: b.priority ?? 0,
              enabled: b.enabled ?? true,
              conditions: JSON.stringify(b.conditions),
              value: b.value === undefined ? null : JSON.stringify(b.value),
              rolloutPercentage: b.rolloutPercentage ?? null,
              createdAt: now,
              updatedAt: now,
            },
          })
          const rule = toRule(row)
          await audit(ctx, {
            flagId: flag.id,
            flagKey: flag.key,
            action: "rule.create",
            actorId,
            after: rule,
          })
          return ctx.json({ rule })
        }
      ),
      updateFlagRule: createAuthEndpoint(
        "/flags/admin/rule/update",
        {
          method: "POST",
          body: z.object({
            id: z.string().min(1),
            priority: z.number().int().optional(),
            enabled: z.boolean().optional(),
            conditions: z.array(condition).max(50).optional(),
            value: flagValue.optional(),
            rolloutPercentage: percentage.nullish(),
          }),
        },
        async (ctx) => {
          const { actorId } = await requireAdmin(ctx)
          const b = ctx.body
          const adapter = ctx.context.adapter
          const existing = await adapter.findOne<RuleRow>({
            model: MODELS.rule,
            where: [{ field: "id", value: b.id }],
          })
          if (!existing)
            throw new APIError("NOT_FOUND", { code: "RULE_NOT_FOUND" })
          const flag = await adapter.findOne<FlagRow>({
            model: MODELS.flag,
            where: [{ field: "id", value: existing.flagId }],
          })
          if (!flag) throw new APIError("NOT_FOUND", { code: "FLAG_NOT_FOUND" })
          if (b.value !== undefined)
            checkType(flag.type as FlagType, b.value, "value")
          const update: Record<string, unknown> = { updatedAt: new Date() }
          if (b.priority !== undefined) update.priority = b.priority
          if (b.enabled !== undefined) update.enabled = b.enabled
          if (b.conditions !== undefined)
            update.conditions = JSON.stringify(b.conditions)
          if (b.value !== undefined) update.value = JSON.stringify(b.value)
          if (b.rolloutPercentage !== undefined)
            update.rolloutPercentage = b.rolloutPercentage
          const row =
            (await adapter.update<RuleRow>({
              model: MODELS.rule,
              where: [{ field: "id", value: existing.id }],
              update,
            })) ?? ({ ...existing, ...update } as RuleRow)
          const rule = toRule(row)
          await audit(ctx, {
            flagId: flag.id,
            flagKey: flag.key,
            action: "rule.update",
            actorId,
            before: toRule(existing),
            after: rule,
          })
          return ctx.json({ rule })
        }
      ),
      deleteFlagRule: createAuthEndpoint(
        "/flags/admin/rule/delete",
        { method: "POST", body: z.object({ id: z.string().min(1) }) },
        async (ctx) => {
          const { actorId } = await requireAdmin(ctx)
          const adapter = ctx.context.adapter
          const existing = await adapter.findOne<RuleRow>({
            model: MODELS.rule,
            where: [{ field: "id", value: ctx.body.id }],
          })
          if (!existing)
            throw new APIError("NOT_FOUND", { code: "RULE_NOT_FOUND" })
          const flag = await adapter.findOne<FlagRow>({
            model: MODELS.flag,
            where: [{ field: "id", value: existing.flagId }],
          })
          await adapter.delete({
            model: MODELS.rule,
            where: [{ field: "id", value: existing.id }],
          })
          await audit(ctx, {
            flagId: existing.flagId,
            flagKey: flag?.key ?? "",
            action: "rule.delete",
            actorId,
            before: toRule(existing),
          })
          return ctx.json({ success: true })
        }
      ),

      // ----- admin: audit -----
      listFlagAudit: createAuthEndpoint(
        "/flags/admin/audit",
        {
          method: "GET",
          query: z
            .object({
              flagKey: z.string().optional(),
              actorId: z.string().optional(),
              limit: z.coerce.number().int().min(1).max(500).optional(),
              offset: z.coerce.number().int().min(0).optional(),
            })
            .optional(),
        },
        async (ctx) => {
          await requireAdmin(ctx)
          const q = ctx.query ?? {}
          const where = [
            ...(q.flagKey ? [{ field: "flagKey", value: q.flagKey }] : []),
            ...(q.actorId ? [{ field: "actorId", value: q.actorId }] : []),
          ]
          const [rows, total] = await Promise.all([
            ctx.context.adapter.findMany<AuditRow>({
              model: MODELS.audit,
              where,
              sortBy: { field: "createdAt", direction: "desc" },
              limit: q.limit ?? 50,
              offset: q.offset ?? 0,
            }),
            ctx.context.adapter.count({ model: MODELS.audit, where }),
          ])
          return ctx.json({ entries: rows.map(toAudit), total })
        }
      ),
    },
    $ERROR_CODES: {
      FLAG_NOT_FOUND: { code: "FLAG_NOT_FOUND", message: "Flag not found" },
      FLAG_EXISTS: { code: "FLAG_EXISTS", message: "Flag already exists" },
      RULE_NOT_FOUND: { code: "RULE_NOT_FOUND", message: "Rule not found" },
      INVALID_FLAG_VALUE: {
        code: "INVALID_FLAG_VALUE",
        message: "Value does not match the flag type",
      },
      FEATURE_FLAGS_FORBIDDEN: {
        code: "FEATURE_FLAGS_FORBIDDEN",
        message: "Not allowed to manage feature flags",
      },
    },
  } satisfies BetterAuthPlugin
}

export type FeatureFlagsPlugin = ReturnType<typeof featureFlags>
