import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { admin, organization } from "better-auth/plugins"
import { featureFlags, type FeatureFlagsOptions } from "../src/server.ts"

export const BASE_URL = "http://localhost:3000"

export function memoryDb() {
  const db: Record<string, Record<string, unknown>[]> = {}
  for (const t of [
    "user",
    "session",
    "account",
    "verification",
    "organization",
    "member",
    "invitation",
    "team",
    "teamMember",
    "featureFlag",
    "featureFlagOverride",
    "featureFlagRule",
    "featureFlagAudit",
  ])
    db[t] = []
  return db
}

export function makeAuth(
  flagOptions: FeatureFlagsOptions = { cache: { ttlSeconds: 0 } },
  database: Parameters<typeof betterAuth>[0]["database"] = memoryAdapter(
    memoryDb()
  ),
  extra: { organization?: boolean; admin?: boolean } = {}
) {
  return betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-0123456789",
    trustedOrigins: [BASE_URL],
    database,
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [
      ...(extra.admin === false ? [] : [admin()]),
      ...(extra.organization === false ? [] : [organization()]),
      featureFlags(flagOptions),
    ],
  })
}

export type Auth = ReturnType<typeof makeAuth>

/** Signs up a user and returns cookie headers for them. */
export async function signUp(auth: Auth, email: string, role?: string) {
  const { headers: res, response } = await auth.api.signUpEmail({
    body: { email, password: "password-123456", name: email.split("@")[0]! },
    returnHeaders: true,
  })
  const userId = response.user.id
  if (role) {
    const ctx = await auth.$context
    await ctx.adapter.update({
      model: "user",
      where: [{ field: "id", value: userId }],
      update: { role },
    })
  }
  const cookie = (res.getSetCookie?.() ?? [res.get("set-cookie") ?? ""])
    .map((c) => c.split(";")[0])
    .join("; ")
  const headers = new Headers({ cookie, origin: BASE_URL })
  return { userId, headers }
}

export async function http(
  auth: Auth,
  path: string,
  init: { method?: string; headers?: Headers; body?: unknown } = {}
) {
  const headers = new Headers(init.headers)
  headers.set("origin", BASE_URL)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  const res = await auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  )
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
