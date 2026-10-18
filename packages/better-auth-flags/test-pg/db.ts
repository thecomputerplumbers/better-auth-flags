import { getSchema } from "better-auth/db"
import pg from "pg"
import type { Auth } from "../test/helpers.ts"

export const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL)
  throw new Error("Set DATABASE_URL to a Postgres database for test:pg")

/** A pool whose connections use their own schema, recreated empty. */
export async function freshSchema(name: string) {
  const admin = new pg.Pool({ connectionString: DATABASE_URL })
  await admin.query(`drop schema if exists "${name}" cascade`)
  await admin.query(`create schema "${name}"`)
  await admin.end()
  return new pg.Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path="${name}"`,
  })
}

type Field = {
  type: string | string[]
  required?: boolean
  unique?: boolean
  references?: { model: string; field: string; onDelete?: string }
}

/**
 * Creates every table better-auth and its plugins declare, the way Versal
 * does: uuid ids defaulting to Postgres 18's uuidv7(), uuid foreign keys.
 * Returns the column kinds so a Drizzle schema can mirror them.
 */
export async function createTablesLikeVersal(
  pool: pg.Pool,
  options: Auth["options"]
) {
  const tables = getSchema(options) as Record<
    string,
    { fields: Record<string, Field>; order: number }
  >
  const kinds: Record<string, Record<string, string>> = {}
  const entries = Object.entries(tables).sort((a, b) => a[1].order - b[1].order)
  for (const [table, { fields }] of entries) {
    kinds[table] = { id: "uuid" }
    const cols = [`"id" uuid primary key default uuidv7()`]
    for (const [col, f] of Object.entries(fields)) {
      const kind = f.references
        ? "uuid"
        : f.type === "boolean"
          ? "boolean"
          : f.type === "number"
            ? "integer"
            : f.type === "date"
              ? "timestamptz"
              : f.type === "json"
                ? "jsonb"
                : "text"
      kinds[table][col] = kind
      let def = `"${col}" ${kind}`
      if (f.required) def += " not null"
      if (f.unique) def += " unique"
      if (f.references)
        def += ` references "${f.references.model}"("${f.references.field}") on delete ${f.references.onDelete ?? "cascade"}`
      cols.push(def)
    }
    await pool.query(`create table "${table}" (${cols.join(", ")})`)
  }
  return kinds
}
