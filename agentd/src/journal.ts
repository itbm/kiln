import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { JournalBlob, SessionState } from "./types.js"
import { log, errClass } from "./log.js"

/**
 * The session journal (§5.7) — the only durable server-side state, sized to
 * do exactly two jobs: never orphan a sandbox, and let the phone learn what
 * happened to its sessions after an agentd restart.
 *
 * Format: append-only JSONL, last-write-wins per session id, compacted on
 * boot. (M1 decision: JSONL over SQLite — a few hundred bytes per session
 * doesn't justify a native dependency in a read-only container.)
 *
 * Each row is a plaintext envelope `{ id, expiresAt, tombstone? }` plus an
 * AES-256-GCM `blob` encrypted with a key only the client holds. agentd
 * keeps that key in RAM only; the file at rest is unreadable to the server
 * itself. `tombstone` doubles as the plaintext terminal-state marker so boot
 * reconciliation can tombstone non-terminal rows without decrypting a byte.
 */

export interface JournalRow {
  id: string
  expiresAt: number
  /** plaintext terminal marker: a terminal SessionState once the session ends */
  tombstone?: SessionState
  /** base64(iv || ciphertext || gcmTag) */
  blob?: string
}

interface Line extends JournalRow {
  v: 1
}

function encrypt(key: Buffer, data: JournalBlob): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const plain = Buffer.from(JSON.stringify(data), "utf8")
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64")
}

export function decryptBlob(key: Buffer, blob: string): JournalBlob | null {
  try {
    const buf = Buffer.from(blob, "base64")
    if (buf.length < 12 + 16) return null
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const data = buf.subarray(12, buf.length - 16)
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(data), decipher.final()])
    return JSON.parse(plain.toString("utf8")) as JournalBlob
  } catch {
    // wrong key (or corrupt row) — indistinguishable by design
    return null
  }
}

export class Journal {
  private byId = new Map<string, JournalRow>()

  constructor(
    private path: string,
    private retentionMs: number,
  ) {}

  /** Load + compact. Returns the surviving rows. */
  load(): JournalRow[] {
    try {
      if (existsSync(this.path)) {
        for (const line of readFileSync(this.path, "utf8").split("\n")) {
          if (!line.trim()) continue
          try {
            const row = JSON.parse(line) as Line
            if (row?.v === 1 && typeof row.id === "string") this.byId.set(row.id, row)
          } catch {
            // skip torn tail line from a crash mid-append
          }
        }
      }
    } catch (e) {
      log("warn", "journal load failed; starting empty", { err: errClass(e) })
    }
    const now = Date.now()
    for (const [id, row] of this.byId) if (row.expiresAt <= now) this.byId.delete(id)
    this.compact()
    return [...this.byId.values()]
  }

  private compact(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const body = [...this.byId.values()]
        .map((r) => JSON.stringify({ v: 1, ...r } satisfies Line))
        .join("\n")
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, body ? body + "\n" : "")
      renameSync(tmp, this.path)
    } catch (e) {
      log("warn", "journal compact failed", { err: errClass(e) })
    }
  }

  private append(row: JournalRow): void {
    this.byId.set(row.id, row)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify({ v: 1, ...row } satisfies Line) + "\n")
    } catch (e) {
      // never let bookkeeping take a session down
      log("warn", "journal append failed", { id: row.id, err: errClass(e) })
    }
  }

  /**
   * Record the session's current blob. Without a key the previous blob (if
   * any) is carried forward so envelope-only updates never destroy data.
   */
  put(id: string, data: JournalBlob, key: Buffer | null): void {
    const prev = this.byId.get(id)
    const terminal = data.state
    this.append({
      id,
      expiresAt: Date.now() + this.retentionMs,
      tombstone: isTerminal(terminal) ? terminal : undefined,
      blob: key ? encrypt(key, data) : prev?.blob,
    })
  }

  /** Plaintext-only terminal marker (used by key-less boot reconciliation). */
  tombstone(id: string, state: SessionState): void {
    const prev = this.byId.get(id)
    this.append({
      id,
      expiresAt: prev?.expiresAt ?? Date.now() + this.retentionMs,
      tombstone: state,
      blob: prev?.blob,
    })
  }

  delete(id: string): void {
    if (!this.byId.has(id)) return
    this.byId.delete(id)
    this.compact()
  }

  rows(): JournalRow[] {
    return [...this.byId.values()]
  }

  get(id: string): JournalRow | undefined {
    return this.byId.get(id)
  }
}

function isTerminal(s: SessionState): boolean {
  return (
    s === "completed" || s === "failed" || s === "cancelled" || s === "interrupted" || s === "expired"
  )
}
