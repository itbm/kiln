import type { AgentSessionStatus } from "@/lib/types"

/**
 * Hand-mirrored subset of kiln-agentd's wire types (agentd/src/types.ts).
 * Keep the shapes in sync — the runner is versioned with this repo.
 */

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
  /** monotonic per session; 0 = synthetic (not part of the replayable log) */
  seq: number
  ts: number
  type: AgentEventType
  payload: Record<string, unknown>
}

export type AgentNetworkPolicy = "allow-all" | "balanced" | "deny-all"
export type AgentPermissionMode = "bypassPermissions" | "acceptEdits" | "plan"

export interface AgentSessionSummary {
  id: string
  state: AgentSessionStatus
  repo: string
  baseBranch: string
  taskBranch: string
  createdAt: number
  lastActivityAt?: number
  latestSeq: number
  prUrl?: string
  tornDown?: boolean
  fromJournal?: boolean
}

export interface CreateSessionBody {
  task: string
  repo: { owner: string; name: string; baseBranch: string }
  provider: { baseUrl: string; token: string; model: string; smallModel?: string }
  github: { token: string }
  options?: {
    maxTurns?: number
    permissionMode?: AgentPermissionMode
    network?: {
      policy?: AgentNetworkPolicy
      allowPackageManagers?: boolean
      extraHosts?: string[]
    }
    idleTtlMinutes?: number
    hardTtlMinutes?: number
  }
  resume?: { taskBranch: string; mode: "continue" | "retry"; history?: string }
}

export interface CreateSessionResponse {
  id: string
  state: AgentSessionStatus
  taskBranch: string
  events: string
}

export interface RunnerHealth {
  ok: boolean
  driver: {
    ok: boolean
    driver: string
    apiVersion?: string
    apiVersionOk?: boolean
    kvm?: boolean
    templatePresent?: boolean
    detail?: string
  }
  sessions: { live: number; max: number }
  template: string
}
