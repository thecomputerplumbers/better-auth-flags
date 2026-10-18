import { after } from "node:test"
import { getMigrations } from "better-auth/db/migration"
import type pg from "pg"
import { makeAuth } from "../test/helpers.ts"
import { freshSchema } from "./db.ts"
import { scenarios } from "./scenarios.ts"

const pools: pg.Pool[] = []
after(() => Promise.all(pools.map((p) => p.end())))

let n = 0
scenarios(
  "Postgres, built-in Kysely adapter, better-auth migrations",
  async () => {
    const pool = await freshSchema(`baf_kysely_${n++}`)
    pools.push(pool)
    const auth = makeAuth({ cache: { ttlSeconds: 0 } }, pool)
    const { runMigrations } = await getMigrations(auth.options)
    await runMigrations()
    return auth
  }
)
