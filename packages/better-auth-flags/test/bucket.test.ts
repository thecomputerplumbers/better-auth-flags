import assert from "node:assert/strict"
import { test } from "node:test"
import { bucket } from "../src/bucket.ts"

test("bucket is stable for the same flag and subject", () => {
  assert.equal(bucket("new-nav", "user_1"), bucket("new-nav", "user_1"))
})

test("bucket stays in range and spreads roughly evenly", () => {
  let under50 = 0
  for (let i = 0; i < 10000; i++) {
    const b = bucket("new-nav", `user_${i}`)
    assert.ok(b >= 0 && b < 10000)
    if (b < 5000) under50++
  }
  assert.ok(under50 > 4700 && under50 < 5300, `got ${under50}`)
})

test("bucket differs per flag for the same subject", () => {
  const values = new Set(["a", "b", "c", "d", "e"].map((k) => bucket(k, "u")))
  assert.ok(values.size > 1)
})
