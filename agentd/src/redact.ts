/**
 * Secret redaction (§8.3). At session creation we build a set of needles for
 * each secret — verbatim plus the encodings a model (or tool output) is
 * likely to smuggle it through — and substitute a fixed marker in every
 * outbound byte path before anything is buffered or fanned out.
 *
 * This is defence-in-depth behind the egress policy, not the primary control.
 */

export const REDACTED = "•••kiln-redacted•••"

/** Secrets shorter than this are not worth pattern-matching (and would
 *  shred ordinary text); real tokens are far longer. */
const MIN_SECRET_LEN = 8

function variants(secret: string): string[] {
  const out = new Set<string>()
  out.add(secret)
  out.add(Buffer.from(secret, "utf8").toString("base64"))
  out.add(Buffer.from(secret, "utf8").toString("base64url"))
  out.add(encodeURIComponent(secret))
  // how the token looks embedded inside a JSON string
  out.add(JSON.stringify(secret).slice(1, -1))
  return [...out].filter((v) => v.length >= MIN_SECRET_LEN)
}

export class Redactor {
  private needles: string[]

  constructor(secrets: string[]) {
    const all = new Set<string>()
    for (const s of secrets) {
      if (!s || s.length < MIN_SECRET_LEN) continue
      for (const v of variants(s)) all.add(v)
    }
    // longest first so partial overlaps can't leave a recognisable tail
    this.needles = [...all].sort((a, b) => b.length - a.length)
  }

  redact(text: string): string {
    let out = text
    for (const n of this.needles) out = out.split(n).join(REDACTED)
    return out
  }

  /** Recursively redact every string in a JSON-ish value. */
  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as unknown as T
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as unknown as T
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[this.redact(k)] = this.redactDeep(v)
      return out as unknown as T
    }
    return value
  }

  /**
   * Streaming variant for raw chunked output: keeps a small carry so a
   * secret split across chunk boundaries is still caught. Call `flush()`
   * at end of stream.
   */
  stream(): { push: (chunk: string) => string; flush: () => string } {
    const maxLen = this.needles[0]?.length ?? 0
    let carry = ""
    return {
      push: (chunk: string): string => {
        const text = carry + chunk
        if (maxLen === 0) {
          carry = ""
          return text
        }
        const keep = Math.min(maxLen - 1, text.length)
        const safe = this.redact(text.slice(0, text.length - keep))
        carry = text.slice(text.length - keep)
        return safe
      },
      flush: (): string => {
        const out = this.redact(carry)
        carry = ""
        return out
      },
    }
  }
}
