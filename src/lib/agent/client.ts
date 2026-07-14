import { getSettings } from "@/stores/settings"
import type {
  AgentEvent,
  AgentSessionSummary,
  CreateSessionBody,
  CreateSessionResponse,
  RunnerHealth,
} from "./types"

/**
 * Thin client for the kiln-agentd Session API (base path `<runner>/v1`).
 * The runner URL defaults to the same origin at /agent — the bundled nginx
 * relays it — so no CORS surface exists; a custom URL must be same-origin
 * or proxied. Secrets are write-only: they ride the create request and are
 * never echoed by any route or event.
 */

export function runnerConfigured(): boolean {
  return !!getSettings().agentRunnerToken
}

function base(): string {
  const s = getSettings()
  const url = s.agentRunnerUrl.trim() || "/agent"
  return url.replace(/\/+$/, "")
}

function headers(): Record<string, string> {
  const s = getSettings()
  const h: Record<string, string> = {
    Authorization: `Bearer ${s.agentRunnerToken}`,
    "Content-Type": "application/json",
  }
  if (s.agentJournalKey) h["X-Kiln-Journal-Key"] = s.agentJournalKey
  return h
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base()}/v1${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let message = `runner error ${res.status}`
    try {
      const data = (await res.json()) as { error?: string }
      if (data?.error) message = data.error
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

export const createSession = (body: CreateSessionBody) =>
  call<CreateSessionResponse>("POST", "/sessions", body)

export const listSessions = () =>
  call<{ sessions: AgentSessionSummary[] }>("GET", "/sessions").then((r) => r.sessions)

export const getSession = (id: string) =>
  call<AgentSessionSummary>("GET", `/sessions/${id}`)

export const sendInput = (id: string, text: string) =>
  call<{ ok: true }>("POST", `/sessions/${id}/input`, { type: "user_message", text })

export const cancelSession = (id: string) =>
  call<{ ok: true }>("POST", `/sessions/${id}/cancel`)

export const finaliseSession = (id: string) =>
  call<AgentSessionSummary>("POST", `/sessions/${id}/finalise`)

export const deleteSession = (id: string) =>
  call<{ ok: true }>("DELETE", `/sessions/${id}`)

export async function runnerHealth(): Promise<RunnerHealth> {
  const res = await fetch(`${base()}/healthz`)
  if (!res.ok) throw new Error(`runner unreachable (${res.status})`)
  return (await res.json()) as RunnerHealth
}

/** base64url without padding — token transport inside the WS subprotocol. */
function b64url(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/**
 * Live event stream with replay: connects `?after=<seq>`, receives the gap,
 * then live-tails. Browsers can't set headers on WebSocket, so the bearer
 * rides the second subprotocol entry (the server selects the first).
 */
export function openEvents(
  sessionId: string,
  after: number,
  handlers: {
    onEvent: (ev: AgentEvent) => void
    onOpen?: () => void
    onClose?: (clean: boolean) => void
  },
): { close: () => void } {
  const url = new URL(`${base()}/v1/sessions/${sessionId}/events`, window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("after", String(after))
  const token = getSettings().agentRunnerToken
  const ws = new WebSocket(url, ["kiln-agent-v1", `bearer.${b64url(token)}`])
  let closedByUs = false
  ws.onopen = () => handlers.onOpen?.()
  ws.onmessage = (e) => {
    try {
      const ev = JSON.parse(String(e.data)) as AgentEvent
      if (ev && typeof ev.seq === "number" && typeof ev.type === "string") handlers.onEvent(ev)
    } catch {
      /* ignore malformed frames */
    }
  }
  ws.onclose = () => handlers.onClose?.(closedByUs)
  ws.onerror = () => {
    /* onclose follows; reconnect lives in the runtime */
  }
  return {
    close: () => {
      closedByUs = true
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    },
  }
}

/** Generate the client-held journal key (once, at runner setup). */
export function generateJournalKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}
