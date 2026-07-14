/**
 * Shared types for kiln-agentd: the session API surface (§6 of the spec),
 * the in-memory session record, and the event envelope streamed to the
 * phone. The Kiln client keeps a hand-mirrored subset of these in
 * `src/lib/agent/types.ts` — keep the wire shapes in sync.
 */

export type SessionState =
  | "created"
  | "provisioning"
  | "cloning"
  | "running"
  | "finalising"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "expired"

export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "expired",
])

export type NetworkProfile = "allow-all" | "balanced" | "deny-all"
export type PermissionMode = "bypassPermissions" | "acceptEdits" | "plan"

export interface NetworkOptions {
  policy: NetworkProfile
  allowPackageManagers: boolean
  /** extra sandbox-scoped allow rules: `host:port` or `**.host` globs */
  extraHosts: string[]
}

export interface SessionOptions {
  maxTurns: number
  permissionMode: PermissionMode
  network: NetworkOptions
  idleTtlMinutes: number
  hardTtlMinutes: number
}

export interface RepoRef {
  owner: string
  name: string
  baseBranch: string
}

export interface ProviderConfig {
  /** e.g. https://openrouter.ai/api or https://ollama.com */
  baseUrl: string
  model: string
  smallModel?: string
}

export interface ResumeSpec {
  taskBranch: string
  mode: "continue" | "retry"
  /** client-supplied compacted transcript of the prior attempt (advisory) */
  history?: string
}

/** Body of POST /agent/v1/sessions. Secrets are write-only: never echoed. */
export interface CreateSessionRequest {
  task: string
  repo: RepoRef
  provider: ProviderConfig & { token: string }
  github: { token: string }
  options?: Partial<SessionOptions> & { network?: Partial<NetworkOptions> }
  resume?: ResumeSpec
}

export type AgentEventType =
  | "state"
  | "bootstrap"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "diff"
  | "pr"
  | "result"
  | "warning"
  | "error"

export interface AgentEvent {
  seq: number
  ts: number
  type: AgentEventType
  payload: Record<string, unknown>
}

/** What GET /sessions and GET /sessions/{id} return — no secrets, no content. */
export interface SessionSummary {
  id: string
  state: SessionState
  repo: string
  baseBranch: string
  taskBranch: string
  createdAt: number
  lastActivityAt?: number
  latestSeq: number
  prUrl?: string
  tornDown?: boolean
  /** true when the row was recovered from the journal (pre-restart session) */
  fromJournal?: boolean
}

/** The encrypted journal blob (§5.7) — the only durable server-side state. */
export interface JournalBlob {
  sandboxName: string
  state: SessionState
  repo: string
  baseBranch: string
  taskBranch: string
  createdAt: number
  prUrl?: string
  lastSeq: number
}
