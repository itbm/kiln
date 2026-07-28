import type {
  Effort,
  ModelRef,
  ToolDef,
  TurnEvent,
  WireMessage,
} from "./types"
import { getSettings } from "@/stores/settings"
import { cleanKey } from "./utils"

/**
 * Client for the Kiln server's cloud turn runner (server/cloud.mjs, reached
 * same-origin through nginx — /api/cloud). A job is one assistant turn; the
 * server journals every TurnEvent and this module replays the journal over
 * SSE, live-tailing while the turn is still running.
 *
 * Choosing cloud is the one place Kiln's "everything stays on the device"
 * rule bends: the conversation payload and the API keys needed to run the
 * turn are held in the server's memory while it works, and the finished
 * journal until the device collects it (or 24 h). Nothing is written to
 * disk server-side, and the result lands in IndexedDB like any other reply.
 */

const BASE = "/api/cloud"

/** The job vanished server-side (collected, expired, or the server restarted). */
export class CloudJobGone extends Error {
  constructor() {
    super("The server no longer has this reply")
    this.name = "CloudJobGone"
  }
}

/** Couldn't reach the runner for long enough that we stopped trying. */
export class CloudDetached extends Error {
  constructor() {
    super("Lost contact with the server while it was generating")
    this.name = "CloudDetached"
  }
}

/** A journal entry as served: a TurnEvent with its position. */
export type CloudEntry = TurnEvent & { seq: number }

/** Is the cloud runner deployed and reachable? (Old servers just 404 here.) */
export async function probeCloud(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    })
    if (!res.ok) return false
    const json = await res.json()
    return json?.ok === true
  } catch {
    return false
  }
}

export interface CloudJobOptions {
  modelRef: ModelRef
  effort: Effort
  messages: WireMessage[]
  tools: ToolDef[]
  imageOutput: boolean
}

/** Hand a turn to the server; returns the job id to attach to. */
export async function createCloudJob(opts: CloudJobOptions): Promise<string> {
  const s = getSettings()
  const provider = opts.modelRef.provider
  const keys: { provider?: string; tavily?: string } = {}
  if (provider === "openrouter") {
    const key = cleanKey(s.openrouterKey)
    if (!key)
      throw new Error(
        "No OpenRouter API key configured — add one in Settings → Providers",
      )
    keys.provider = key
  } else {
    const key = cleanKey(s.ollamaKey)
    if (key) keys.provider = key
  }
  if (opts.tools.some((t) => t.name === "web_search")) {
    const key = cleanKey(s.tavilyKey)
    if (key) keys.tavily = key
  }
  const res = await fetch(`${BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      model: opts.modelRef.model,
      effort: opts.effort,
      messages: opts.messages,
      tools: opts.tools.length ? opts.tools : undefined,
      imageOutput: opts.imageOutput || undefined,
      ollamaBaseUrl: provider === "ollama" ? s.ollamaBaseUrl : undefined,
      keys,
    }),
  })
  if (!res.ok) {
    let msg = `Cloud runner: HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j.error) msg = j.error
    } catch {
      /* keep status */
    }
    throw new Error(msg)
  }
  const json = await res.json()
  if (typeof json.id !== "string") throw new Error("Cloud runner: bad response")
  return json.id
}

/**
 * Stream a job's journal from `from`, live-tailing until the final entry.
 * Ends when the server closes the stream; whether a `final` arrived is the
 * caller's to track. Throws CloudJobGone on 404.
 */
export async function* attachCloudJob(
  id: string,
  signal: AbortSignal,
  from = 0,
): AsyncGenerator<CloudEntry> {
  const res = await fetch(`${BASE}/jobs/${id}/events?from=${from}`, {
    headers: { Accept: "text/event-stream" },
    cache: "no-store",
    signal,
  })
  if (res.status === 404) throw new CloudJobGone()
  if (!res.ok || !res.body) throw new Error(`Cloud runner: HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        let entry: CloudEntry
        try {
          entry = JSON.parse(trimmed.slice(5))
        } catch {
          continue
        }
        yield entry
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** Ask the server to stop generating. The journal still ends with a final. */
export async function stopCloudJob(id: string): Promise<void> {
  try {
    await fetch(`${BASE}/jobs/${id}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    /* the attach retry loop and the server's caps clean up after us */
  }
}

/** The result is safely on the device — the server can forget it now. */
export async function deleteCloudJob(id: string): Promise<void> {
  try {
    await fetch(`${BASE}/jobs/${id}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    /* best-effort; the server expires uncollected jobs after 24 h */
  }
}
