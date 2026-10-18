import { after } from "node:test"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/node-postgres"
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import type pg from "pg"
import { makeAuth } from "../test/helpers.ts"
import { createTablesLikeVersal, freshSchema } from "./db.ts"
import { scenarios } from "./scenarios.ts"

const pools: pg.Pool[] = []
after(() => Promise.all(pools.map((p) => p.end())))

function drizzleSchema(kinds: Record<string, Record<string, string>>) {
  const schema: Record<string, ReturnType<typeof pgTable>> = {}
  for (const [table, cols] of Object.entries(kinds)) {
    const columns: Record<string, unknown> = {}
    for (const [col, kind] of Object.entries(cols)) {
      columns[col] =
        col === "id"
          ? uuid(col)
              .primaryKey()
              .default(sql`uuidv7()`)
          : kind === "uuid"
            ? uuid(col)
            : kind === "boolean"
              ? boolean(col)
              : kind === "integer"
                ? integer(col)
                : kind === "timestamptz"
                  ? timestamp(col, { withTimezone: true })
                  : kind === "jsonb"
                    ? jsonb(col)
                    : text(col)
    }
    schema[table] = pgTable(table, columns as never)
  }
  return schema
}

let n = 0
// Versal: drizzleAdapter(db, { provider: "pg", schema }) with
// advanced.database.generateId: false and uuidv7() ids.
scenarios(
  "Postgres, Drizzle adapter, uuidv7 ids (Versal's setup)",
  async () => {
    const pool = await freshSchema(`baf_drizzle_${n++}`)
    pools.push(pool)
    // Build the table list from a throwaway instance with the same plugins.
    const probe = makeAuth({ cache: { ttlSeconds: 0 } }, undefined, {
      generateId: false,
    })
    const kinds = await createTablesLikeVersal(pool, probe.options)
    const schema = drizzleSchema(kinds)
    const db = drizzle({ client: pool })
    return makeAuth(
      { cache: { ttlSeconds: 0 } },
      drizzleAdapter(db, { provider: "pg", schema }),
      { generateId: false }
    ) as ReturnType<typeof makeAuth>
  }
)
