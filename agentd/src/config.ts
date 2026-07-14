/** Env-driven configuration. Everything has a sane default except the token. */

export interface Config {
  /** static high-entropy bearer token; required to start */
  token: string
  host: string
  port: number
  /** sandboxd unix socket path */
  sbxSocket: string
  /** host-visible workspace root (must be identically bind-mounted, §10) */
  workspaceRoot: string
  /** encrypted session journal file (JSONL, §5.7) */
  journalPath: string
  maxSessions: number
  /** sandbox template image the runner expects (§5.2) */
  templateImage: string
  /** value for the sbx create request's `agent` field */
  sbxAgent: string
  /** pinned sandboxd api_version this build is validated against (§12) */
  expectedApiVersion: string
  idleTtlMinutes: number
  hardTtlMinutes: number
  /** ring buffer caps (§5.1) */
  eventBufferEvents: number
  eventBufferBytes: number
  /** how long journal rows survive for post-restart recovery */
  journalRetentionDays: number
  /** keep terminal sessions readable in memory for this long */
  retainTerminalMinutes: number
}

function num(name: string, def: number): number {
  const v = process.env[name]
  if (v === undefined || v === "") return def
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${v}"`)
  return n
}

export function loadConfig(env = process.env): Config {
  const token = env.KILN_AGENT_TOKEN ?? ""
  if (token.length < 24)
    throw new Error(
      "KILN_AGENT_TOKEN must be set to a high-entropy secret (24+ chars) — e.g. `openssl rand -base64 33`",
    )
  return {
    token,
    host: env.BIND_HOST ?? "0.0.0.0",
    port: num("PORT", 9090),
    sbxSocket: env.SBX_SOCKET ?? "/run/sandboxd/sandboxd.sock",
    workspaceRoot: env.WORKSPACE_ROOT ?? "/var/kiln-agent",
    journalPath: env.JOURNAL_PATH ?? "/var/lib/agentd/journal.jsonl",
    maxSessions: num("MAX_SESSIONS", 3),
    templateImage: env.KILN_AGENT_TEMPLATE ?? "kiln-agent:0.1.0",
    sbxAgent: env.SBX_AGENT ?? "custom",
    expectedApiVersion: env.SBX_EXPECTED_API_VERSION ?? "0.16.0",
    idleTtlMinutes: num("IDLE_TTL_MINUTES", 30),
    hardTtlMinutes: num("HARD_TTL_MINUTES", 120),
    eventBufferEvents: num("EVENT_BUFFER_EVENTS", 5000),
    eventBufferBytes: num("EVENT_BUFFER_BYTES", 8 * 1024 * 1024),
    journalRetentionDays: num("JOURNAL_RETENTION_DAYS", 14),
    retainTerminalMinutes: num("RETAIN_TERMINAL_MINUTES", 120),
  }
}
