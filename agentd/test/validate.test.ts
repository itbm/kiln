import { test } from "node:test"
import assert from "node:assert/strict"
import { retryBranch, validateCreate, ValidationError } from "../src/validate.js"

const DEFAULTS = { idleTtlMinutes: 30, hardTtlMinutes: 120 }

const base = () => ({
  task: "Fix the flaky retry logic in src/lib/relay.ts and add a unit test",
  repo: { owner: "itbm", name: "kiln", baseBranch: "main" },
  provider: {
    baseUrl: "https://openrouter.ai/api",
    token: "sk-or-v1-0123456789abcdef",
    model: "anthropic/claude-sonnet-4.6",
  },
  github: { token: "github_pat_0123456789abcdef" },
})

test("accepts a minimal valid request and applies defaults", () => {
  const v = validateCreate(base(), DEFAULTS)
  assert.equal(v.options.maxTurns, 60)
  assert.equal(v.options.permissionMode, "bypassPermissions")
  assert.equal(v.options.network.policy, "deny-all")
  assert.equal(v.options.network.allowPackageManagers, true)
  assert.equal(v.options.idleTtlMinutes, 30)
  assert.equal(v.repo.baseBranch, "main")
})

test("rejects http provider URLs and bad branch names", () => {
  assert.throws(
    () => validateCreate({ ...base(), provider: { ...base().provider, baseUrl: "http://x.dev" } }, DEFAULTS),
    ValidationError,
  )
  assert.throws(
    () => validateCreate({ ...base(), repo: { owner: "itbm", name: "kiln", baseBranch: "a..b" } }, DEFAULTS),
    ValidationError,
  )
})

test("validates extraHosts globs", () => {
  const ok = validateCreate(
    { ...base(), options: { network: { extraHosts: ["registry.npmjs.org:443", "**.pypi.org"] } } },
    DEFAULTS,
  )
  assert.deepEqual(ok.options.network.extraHosts, ["registry.npmjs.org:443", "**.pypi.org"])
  assert.throws(
    () => validateCreate({ ...base(), options: { network: { extraHosts: ["bad host"] } } }, DEFAULTS),
    ValidationError,
  )
})

test("resume must target a kiln/* branch", () => {
  const ok = validateCreate(
    { ...base(), resume: { taskBranch: "kiln/fix-relay-a1b2c3", mode: "continue" } },
    DEFAULTS,
  )
  assert.equal(ok.resume?.taskBranch, "kiln/fix-relay-a1b2c3")
  assert.throws(
    () => validateCreate({ ...base(), resume: { taskBranch: "main", mode: "continue" } }, DEFAULTS),
    ValidationError,
  )
})

test("retryBranch appends and increments the attempt suffix", () => {
  assert.equal(retryBranch("kiln/fix-relay-a1b2c3"), "kiln/fix-relay-a1b2c3-2")
  assert.equal(retryBranch("kiln/fix-relay-a1b2c3-2"), "kiln/fix-relay-a1b2c3-3")
  assert.equal(retryBranch("kiln/fix-relay-a1b2c3-9"), "kiln/fix-relay-a1b2c3-10")
})

test("secrets are required and length-checked", () => {
  assert.throws(
    () => validateCreate({ ...base(), github: { token: "x" } }, DEFAULTS),
    ValidationError,
  )
})
