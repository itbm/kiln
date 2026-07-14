import { test } from "node:test"
import assert from "node:assert/strict"
import { EventBuffer } from "../src/ring-buffer.js"

test("seq is monotonic and replay-from-after works", () => {
  const b = new EventBuffer(100, 1024 * 1024)
  for (let i = 0; i < 10; i++) b.append("assistant_text", { text: `t${i}` })
  assert.equal(b.latestSeq, 10)
  const replay = b.since(7)
  assert.deepEqual(
    replay.map((e) => e.seq),
    [8, 9, 10],
  )
})

test("evicts by count and reports oldestSeq", () => {
  const b = new EventBuffer(5, 1024 * 1024)
  for (let i = 0; i < 12; i++) b.append("assistant_text", { text: String(i) })
  assert.equal(b.size, 5)
  assert.equal(b.oldestSeq, 8)
  assert.equal(b.latestSeq, 12)
  // a client that saw only up to seq 2 replays from 8 — gap detectable
  assert.equal(b.since(2)[0]!.seq, 8)
})

test("evicts by bytes", () => {
  const b = new EventBuffer(10_000, 2_000)
  for (let i = 0; i < 50; i++) b.append("tool_result", { output: "x".repeat(200) })
  assert.ok(b.size < 50)
  assert.equal(b.latestSeq, 50)
})
