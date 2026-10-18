import type { BetterAuthPluginDBSchema } from "better-auth/db"

/**
 * Tables, declared through better-auth's plugin schema so
 * `@better-auth/cli generate|migrate` creates them for every adapter.
 * JSON values are stored as strings. Ids are left to the adapter.
 */
export const schema = {
  featureFlag: {
    fields: {
      key: { type: "string", required: true, unique: true },
      type: { type: "string", required: true },
      description: { type: "string", required: false },
      enabled: { type: "boolean", required: true, defaultValue: true },
      defaultValue: { type: "string", required: true },
      variants: { type: "string", required: false },
      rolloutPercentage: { type: "number", required: false },
      rolloutBy: { type: "string", required: true, defaultValue: "user" },
      archivedAt: { type: "date", required: false },
      createdAt: { type: "date", required: true },
      updatedAt: { type: "date", required: true },
    },
  },
  featureFlagOverride: {
    fields: {
      flagId: {
        type: "string",
        required: true,
        index: true,
        references: { model: "featureFlag", field: "id", onDelete: "cascade" },
      },
      subjectType: { type: "string", required: true },
      subjectId: { type: "string", required: true, index: true },
      value: { type: "string", required: true },
      expiresAt: { type: "date", required: false },
      createdBy: { type: "string", required: false },
      createdAt: { type: "date", required: true },
      updatedAt: { type: "date", required: true },
    },
  },
  featureFlagRule: {
    fields: {
      flagId: {
        type: "string",
        required: true,
        index: true,
        references: { model: "featureFlag", field: "id", onDelete: "cascade" },
      },
      priority: { type: "number", required: true, defaultValue: 0 },
      enabled: { type: "boolean", required: true, defaultValue: true },
      conditions: { type: "string", required: true },
      value: { type: "string", required: false },
      rolloutPercentage: { type: "number", required: false },
      createdAt: { type: "date", required: true },
      updatedAt: { type: "date", required: true },
    },
  },
  featureFlagAudit: {
    fields: {
      flagId: { type: "string", required: false, index: true },
      flagKey: { type: "string", required: true, index: true },
      action: { type: "string", required: true },
      actorId: { type: "string", required: false },
      before: { type: "string", required: false },
      after: { type: "string", required: false },
      createdAt: { type: "date", required: true },
    },
  },
} satisfies BetterAuthPluginDBSchema

export type FeatureFlagsSchema = typeof schema
