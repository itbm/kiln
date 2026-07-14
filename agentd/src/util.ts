import { randomBytes, createHash, timingSafeEqual } from "node:crypto"

/** 128-bit random URL-safe id — the session's capability handle. */
export function sessionId(): string {
  return randomBytes(16).toString("base64url")
}

/** Six lowercase [a-z0-9] chars for branch/sandbox names. */
export function shortId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = randomBytes(6)
  let out = ""
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

/** Kebab-case slug of the task's first words, for the branch name. */
export function taskSlug(task: string, max = 24): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "")
  return slug || "task"
}

/** Constant-time bearer comparison (hash first so lengths never leak). */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest()
  const b = createHash("sha256").update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Parse a 256-bit key given as 64 hex chars or base64/base64url. */
export function parseJournalKey(raw: string): Buffer | null {
  const s = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex")
  try {
    const b = Buffer.from(s, "base64")
    if (b.length === 32) return b
  } catch {
    /* fall through */
  }
  return null
}

export function nowMs(): number {
  return Date.now()
}

/** Race a promise against a timeout that rejects. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
