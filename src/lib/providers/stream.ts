/**
 * Line reader for provider streams, with a watchdog on silence.
 *
 * A provider that stops sending without closing the connection would
 * otherwise hold a turn open forever: the read never resolves, so nothing
 * errors, nothing finishes, and the only way out is tapping Stop. The server
 * has guarded against this since the cloud runner existed; this is the same
 * guard for turns that run on the device.
 *
 * Mirrors `lines()` in server/cloud.mjs — change them together.
 */

/** abort a provider stream that goes silent for this long
 *  — mirrors IDLE_CAP_MS in server/cloud.mjs */
export const IDLE_CAP_MS = 300 * 1000

export async function* streamLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  idleMs: number = IDLE_CAP_MS,
): AsyncGenerator<string> {
  // let an e2e run the watchdog on a human timescale
  const idle = (globalThis as { __KILN_IDLE_MS?: number }).__KILN_IDLE_MS ?? idleMs
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let failWatch: (e: Error) => void = () => {}
  const watchdog = new Promise<never>((_, reject) => {
    failWatch = reject
  })
  watchdog.catch(() => {}) // only ever observed inside the race below
  const arm = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () =>
        failWatch(
          new Error("Provider stream stalled (no data for 5 minutes)"),
        ),
      idle,
    )
  }
  // one listener for the whole read, not one per chunk
  const onAbort = () =>
    failWatch(
      signal?.reason instanceof Error
        ? signal.reason
        : (new DOMException("This operation was aborted", "AbortError") as Error),
    )
  if (signal?.aborted) onAbort()
  signal?.addEventListener("abort", onAbort, { once: true })
  arm()
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), watchdog])
      if (done) break
      arm()
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n")
      buf = parts.pop() ?? ""
      for (const line of parts) yield line
    }
    if (buf) yield buf
  } finally {
    clearTimeout(idleTimer)
    signal?.removeEventListener("abort", onAbort)
    reader.cancel().catch(() => {})
  }
}
