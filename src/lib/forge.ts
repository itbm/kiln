import type { Attachment, CodeRepo, ProviderId, TurnEvent } from "./types"
import { getSettings } from "@/stores/settings"
import { cleanKey } from "./utils"

/**
 * Client for the Kiln forge (server/forge, reached same-origin through nginx
 * at /api/forge). A job is one coding turn; the server journals every
 * TurnEvent and this module replays that journal over SSE, live-tailing while
 * the turn runs.
 *
 * Deliberately shaped like lib/cloud.ts — same job/attach/stop/delete
 * lifecycle, same reconnect semantics — because it is the same journal
 * protocol one hop further out. The differences are the job body (a repo and
 * a prompt rather than a conversation) and `replyToForgeJob`, which answers
 * the questions the agent asks mid-turn.
 *
 * Code chats bend Kiln's "everything stays on the device" rule further than
 * cloud chats do: the repository and the agent's own transcript live on the
 * server's disk, on an operator-provided encrypted mount, for as long as the
 * chat exists. The README says so plainly; so should any UI that offers this.
 */

const BASE = "/api/forge"

/** The job vanished server-side (collected, expired, or the forge restarted). */
export class ForgeJobGone extends Error {
  constructor() {
    super("The server no longer has this coding turn")
    this.name = "ForgeJobGone"
  }
}

/** Couldn't reach the forge for long enough that we stopped trying. */
export class ForgeDetached extends Error {
  constructor() {
    super("Lost contact with the server while it was coding")
    this.name = "ForgeDetached"
  }
}

export type ForgeEntry = TurnEvent & { seq: number }

export interface ForgeHealth {
  ok: boolean
  reason?: string
}

/**
 * Is the forge deployed and is sbx actually usable? Reports *why* not, so the
 * UI can say "sbx daemon unreachable" instead of hiding the feature and
 * looking broken.
 */
export async function probeForge(): Promise<ForgeHealth> {
  try {
    const res = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    })
    if (!res.ok) return { ok: false }
    const json = await res.json()
    return { ok: json?.ok === true, reason: json?.sbx?.reason }
  } catch {
    return { ok: false }
  }
}

export interface ForgeJobOptions {
  chatId: string
  repo: CodeRepo
  prompt: string
  attachments?: Attachment[]
  provider: ProviderId
  model: string
  /** resume the agent's own session after a process or VM restart */
  resumeSessionId?: string
  /** regenerating a reply branches the agent's history rather than replacing it */
  forkSession?: boolean
}

/** Hand a coding turn to the forge; returns the job id to attach to. */
export async function createForgeJob(opts: ForgeJobOptions): Promise<string> {
  const s = getSettings()
  const githubToken = cleanKey(s.githubToken)
  if (!githubToken)
    throw new Error("No GitHub token configured — add one in Settings → Providers")

  const providerKey =
    opts.provider === "openrouter" ? cleanKey(s.openrouterKey) : cleanKey(s.ollamaKey)
  if (opts.provider === "openrouter" && !providerKey)
    throw new Error("No OpenRouter API key configured — add one in Settings → Providers")

  const res = await fetch(`${BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chatId: opts.chatId,
      repo: opts.repo,
      prompt: opts.prompt,
      // Only the metadata the agent needs to find the file it already has.
      attachments: (opts.attachments ?? []).map((a) => ({
        name: a.name,
        mime: a.mime,
        kind: a.kind,
      })),
      provider: opts.provider,
      model: opts.model,
      resumeSessionId: opts.resumeSessionId,
      forkSession: opts.forkSession,
      secrets: {
        githubToken,
        providerKey,
        ollamaBaseUrl: opts.provider === "ollama" ? s.ollamaBaseUrl : "",
      },
    }),
  })
  if (!res.ok) {
    let msg = `Forge: HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j.error) msg = j.error
    } catch {
      /* keep status */
    }
    throw new Error(msg)
  }
  const json = await res.json()
  if (typeof json.id !== "string") throw new Error("Forge: bad response")
  return json.id
}

/**
 * Stream a job's journal from `from`, live-tailing until the final entry.
 * Throws ForgeJobGone on 404, matching attachCloudJob so the engine's existing
 * lost-job handling covers both runtimes.
 */
export async function* attachForgeJob(
  id: string,
  signal: AbortSignal,
  from = 0,
): AsyncGenerator<ForgeEntry> {
  const res = await fetch(`${BASE}/jobs/${id}/events?from=${from}`, {
    headers: { Accept: "text/event-stream" },
    cache: "no-store",
    signal,
  })
  if (res.status === 404) throw new ForgeJobGone()
  if (!res.ok || !res.body) throw new Error(`Forge: HTTP ${res.status}`)
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
        let entry: ForgeEntry
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

/**
 * Answer a question the agent asked mid-turn. Until this arrives the tool
 * call is blocked server-side, which is the point: an unanswered permission
 * prompt must never read as consent.
 */
export async function replyToForgeJob(
  id: string,
  requestId: string,
  answer: string,
): Promise<void> {
  await fetch(`${BASE}/jobs/${id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, answer }),
    signal: AbortSignal.timeout(8000),
  })
}

/** Ask the forge to stop. The journal still ends with a final. */
export async function stopForgeJob(id: string): Promise<void> {
  try {
    await fetch(`${BASE}/jobs/${id}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    /* the attach retry loop and the server's caps clean up after us */
  }
}

/** The result is safely on the device — the server can forget the journal. */
export async function deleteForgeJob(id: string): Promise<void> {
  try {
    await fetch(`${BASE}/jobs/${id}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    /* best-effort; the forge expires uncollected jobs after 24 h */
  }
}

/**
 * The chat is gone — reap its sandbox and shred its workspace. Best-effort by
 * design: the alternative is blocking a delete the user asked for on a server
 * that may not be reachable.
 */
export async function deleteForgeWorkspace(chatId: string): Promise<void> {
  try {
    await fetch(`${BASE}/workspaces/${chatId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    /* the forge reaps idle workspaces on its own */
  }
}
