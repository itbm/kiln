/**
 * NDJSON-over-stdio protocol between agentd and the in-sandbox agent shim
 * (§5.4). Keep in sync with `sandbox/agent-shim.mjs`.
 */

export interface ShimTaskConfig {
  maxTurns: number
  permissionMode: string
  model: string
}

/** runner → shim */
export type RunnerMessage =
  | { t: "task"; prompt: string; config: ShimTaskConfig }
  | { t: "user_message"; text: string }
  | { t: "cancel" }

/** shim → runner */
export type ShimMessage =
  | { t: "ready" }
  | { t: "sdk"; msg: unknown }
  | { t: "done"; stats?: Record<string, unknown> }
  | { t: "fatal"; error: string }

export function parseShimLine(line: string): ShimMessage | null {
  try {
    const msg = JSON.parse(line) as ShimMessage
    if (msg && typeof msg === "object" && typeof msg.t === "string") return msg
  } catch {
    /* not protocol traffic — e.g. stray stdout from a subprocess */
  }
  return null
}
