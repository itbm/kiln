import { test } from "node:test"
import assert from "node:assert/strict"
import { Redactor, REDACTED } from "../src/redact.js"

const PROVIDER = "sk-or-v1-abcdef0123456789abcdef0123456789"
const GITHUB = "github_pat_11AAAA0000_deadbeefcafef00d"

test("redacts verbatim secrets from text", () => {
  const r = new Redactor([PROVIDER, GITHUB])
  const out = r.redact(`token=${PROVIDER} and ${GITHUB} done`)
  assert.ok(!out.includes(PROVIDER))
  assert.ok(!out.includes(GITHUB))
  assert.ok(out.includes(REDACTED))
})

test("redacts base64, base64url and URL-encoded forms", () => {
  const r = new Redactor([PROVIDER])
  const b64 = Buffer.from(PROVIDER, "utf8").toString("base64")
  const b64u = Buffer.from(PROVIDER, "utf8").toString("base64url")
  const enc = encodeURIComponent(PROVIDER)
  for (const form of [b64, b64u, enc]) {
    assert.ok(!r.redact(`x ${form} y`).includes(form), `leaked form: ${form}`)
  }
})

test("redactDeep walks nested payloads", () => {
  const r = new Redactor([GITHUB])
  const out = r.redactDeep({
    tool: "Bash",
    input: { command: `git push https://x:${GITHUB}@github.com/o/r` },
    list: [GITHUB, { deep: GITHUB }],
  })
  const text = JSON.stringify(out)
  assert.ok(!text.includes(GITHUB))
  assert.equal((text.match(/kiln-redacted/g) ?? []).length, 3)
})

test("streaming redaction catches secrets split across chunks", () => {
  const r = new Redactor([PROVIDER])
  const s = r.stream()
  const mid = Math.floor(PROVIDER.length / 2)
  const full =
    s.push("output: " + PROVIDER.slice(0, mid)) +
    s.push(PROVIDER.slice(mid) + " trailing") +
    s.flush()
  assert.ok(!full.includes(PROVIDER))
  assert.ok(full.includes(REDACTED))
  assert.ok(full.startsWith("output: "))
  assert.ok(full.endsWith(" trailing"))
})

test("short secrets are ignored, ordinary text untouched", () => {
  const r = new Redactor(["short", ""])
  assert.equal(r.redact("a short story"), "a short story")
})
