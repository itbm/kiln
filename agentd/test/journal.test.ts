import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Journal, decryptBlob } from "../src/journal.js"
import type { JournalBlob } from "../src/types.js"

const DAY = 86_400_000

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kiln-journal-"))
  return { dir, path: join(dir, "journal.jsonl") }
}

const blob = (state: JournalBlob["state"]): JournalBlob => ({
  sandboxName: "kiln-abc123",
  state,
  repo: "itbm/kiln",
  baseBranch: "main",
  taskBranch: "kiln/fix-thing-abc123",
  createdAt: 1000,
  lastSeq: 42,
})

test("roundtrip: encrypt with client key, reload, decrypt", () => {
  const { dir, path } = tempPath()
  const key = randomBytes(32)
  try {
    const j = new Journal(path, 14 * DAY)
    j.load()
    j.put("s1", blob("running"), key)

    const j2 = new Journal(path, 14 * DAY)
    const rows = j2.load()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.tombstone, undefined) // running is not terminal
    const dec = decryptBlob(key, rows[0]!.blob!)
    assert.equal(dec?.taskBranch, "kiln/fix-thing-abc123")
    assert.equal(dec?.state, "running")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("wrong key reads nothing; file content has no plaintext branch", () => {
  const { dir, path } = tempPath()
  try {
    const j = new Journal(path, 14 * DAY)
    j.load()
    j.put("s1", blob("running"), randomBytes(32))
    const raw = readFileSync(path, "utf8")
    assert.ok(!raw.includes("kiln/fix-thing"), "branch leaked in plaintext")
    assert.ok(!raw.includes("itbm/kiln"), "repo leaked in plaintext")
    const row = new Journal(path, 14 * DAY).load()[0]!
    assert.equal(decryptBlob(randomBytes(32), row.blob!), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("key-less tombstoning preserves the blob and marks terminal state", () => {
  const { dir, path } = tempPath()
  const key = randomBytes(32)
  try {
    const j = new Journal(path, 14 * DAY)
    j.load()
    j.put("s1", blob("running"), key)

    // simulate restart without the key: reconcile tombstones non-terminal rows
    const j2 = new Journal(path, 14 * DAY)
    for (const row of j2.load()) if (!row.tombstone) j2.tombstone(row.id, "interrupted")

    const j3 = new Journal(path, 14 * DAY)
    const rows = j3.load()
    assert.equal(rows[0]!.tombstone, "interrupted")
    // blob carried forward: the phone can still learn the branch with its key
    assert.equal(decryptBlob(key, rows[0]!.blob!)?.taskBranch, "kiln/fix-thing-abc123")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("terminal put writes the plaintext terminal marker", () => {
  const { dir, path } = tempPath()
  try {
    const j = new Journal(path, 14 * DAY)
    j.load()
    j.put("s1", blob("completed"), null)
    assert.equal(new Journal(path, 14 * DAY).load()[0]!.tombstone, "completed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("expired rows are pruned at load", () => {
  const { dir, path } = tempPath()
  try {
    const j = new Journal(path, -1) // already expired
    j.load()
    j.put("s1", blob("completed"), null)
    assert.equal(new Journal(path, 14 * DAY).load().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("torn tail line from a crash is skipped", () => {
  const { dir, path } = tempPath()
  const key = randomBytes(32)
  try {
    const j = new Journal(path, 14 * DAY)
    j.load()
    j.put("s1", blob("running"), key)
    appendFileSync(path, '{"v":1,"id":"s2","expi') // torn append
    const rows = new Journal(path, 14 * DAY).load()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, "s1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
