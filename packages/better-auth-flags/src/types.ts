/** A flag value. Stored in the database as a JSON string. */
export type FlagValue =
  | boolean
  | string
  | number
  | null
  | FlagValue[]
  | { [key: string]: FlagValue }

export type FlagType = "boolean" | "string" | "number" | "json"
export type RolloutBy = "user" | "organization"
export type SubjectType = "user" | "organization"

export interface Variant {
  value: FlagValue
  /** Relative weight; weights need not sum to 100. */
  weight: number
}

/** A flag as used by `evaluate`, with JSON columns already parsed. */
export interface Flag {
  id?: string
  key: string
  type: FlagType
  description?: string | null
  enabled: boolean
  archived?: boolean
  defaultValue: FlagValue
  variants?: Variant[] | null
  /** 0–100. For boolean flags, the share of subjects that get `true`. */
  rolloutPercentage?: number | null
  rolloutBy: RolloutBy
}

export interface Override {
  subjectType: SubjectType
  subjectId: string
  value: FlagValue
  expiresAt?: Date | null
}

export const OPERATORS = [
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
] as const
export type Operator = (typeof OPERATORS)[number]

export interface Condition {
  /**
   * `user.id`, `user.email`, `user.emailDomain`, `user.role`,
   * `user.createdAt`, `organization.id`, `organization.slug`, `member.role`,
   * or `custom.<name>`.
   */
  attribute: string
  operator: Operator
  value: FlagValue
}

export interface Rule {
  id?: string
  priority: number
  enabled: boolean
  /** All must match. An empty list matches everyone. */
  conditions: Condition[]
  /** Value served on match. Boolean flags default to `true`. */
  value?: FlagValue
  /** 0–100: only this share of matching subjects gets the rule's value. */
  rolloutPercentage?: number | null
}

export interface EvaluationContext {
  user?: {
    id: string
    email?: string | null
    role?: string | null
    createdAt?: Date | string | null
  } | null
  organization?: { id: string; slug?: string | null } | null
  member?: { role?: string | null } | null
  custom?: Record<string, FlagValue | Date | undefined>
  /** Clock for override expiry. Defaults to now. */
  now?: Date
}

export type EvaluationReason =
  | "missing"
  | "disabled"
  | "user_override"
  | "org_override"
  | "rule"
  | "rollout"
  | "default"

export interface Evaluation<T extends FlagValue = FlagValue> {
  value: T
  reason: EvaluationReason
  /** Id of the matching rule, when `reason` is `rule`. */
  ruleId?: string
}
