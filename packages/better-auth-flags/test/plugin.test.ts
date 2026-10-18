import assert from "node:assert/strict"
import { test } from "node:test"
import { featureFlags } from "../src/index.ts"
import { featureFlagsClient } from "../src/client.ts"

test("server and client plugins share an id", () => {
  assert.equal(featureFlags().id, "feature-flags")
  assert.equal(featureFlagsClient().id, featureFlags().id)
})
