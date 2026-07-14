import type {
  CreateSessionRequest,
  NetworkOptions,
  PermissionMode,
  SessionOptions,
} from "./types.js"

/** Raised for malformed requests; the server maps it to a 400. */
export class ValidationError extends Error {
  statusCode = 400
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/
const BRANCH_RE = /^(?!-)[\w\-./]{1,200}$/
const HOST_RULE_RE = /^(\*\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/
const PERMISSION_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "acceptEdits", "plan"])
const NETWORK_PROFILES: ReadonlySet<string> = new Set(["allow-all", "balanced", "deny-all"])

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ValidationError(msg)
}

function str(v: unknown, name: string, max: number, min = 1): string {
  req(typeof v === "string", `${name} must be a string`)
  const s = v as string
  req(s.length >= min && s.length <= max, `${name} must be ${min}–${max} characters`)
  return s
}

export interface ValidatedRequest {
  task: string
  repo: { owner: string; name: string; baseBranch: string }
  provider: { baseUrl: string; token: string; model: string; smallModel?: string }
  github: { token: string }
  options: SessionOptions
  resume?: { taskBranch: string; mode: "continue" | "retry"; history?: string }
}

export function validateCreate(body: unknown, defaults: { idleTtlMinutes: number; hardTtlMinutes: number }): ValidatedRequest {
  req(body && typeof body === "object", "request body must be a JSON object")
  const b = body as CreateSessionRequest

  const task = str(b.task, "task", 32_000)

  req(b.repo && typeof b.repo === "object", "repo is required")
  const owner = str(b.repo.owner, "repo.owner", 100)
  const name = str(b.repo.name, "repo.name", 100)
  req(OWNER_RE.test(owner) && OWNER_RE.test(name), "repo.owner/name contain invalid characters")
  const baseBranch = str(b.repo.baseBranch ?? "main", "repo.baseBranch", 200)
  req(BRANCH_RE.test(baseBranch) && !baseBranch.includes(".."), "repo.baseBranch is not a valid branch name")

  req(b.provider && typeof b.provider === "object", "provider is required")
  const baseUrl = str(b.provider.baseUrl, "provider.baseUrl", 200)
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new ValidationError("provider.baseUrl is not a valid URL")
  }
  req(url.protocol === "https:", "provider.baseUrl must be https")
  const providerToken = str(b.provider.token, "provider.token", 4096, 8)
  const model = str(b.provider.model, "provider.model", 200)
  const smallModel =
    b.provider.smallModel !== undefined && b.provider.smallModel !== ""
      ? str(b.provider.smallModel, "provider.smallModel", 200)
      : undefined

  req(b.github && typeof b.github === "object", "github is required")
  const githubToken = str(b.github.token, "github.token", 4096, 8)

  const o = b.options ?? {}
  const maxTurns = clampInt(o.maxTurns, 60, 1, 500, "options.maxTurns")
  const permissionMode = (o.permissionMode ?? "bypassPermissions") as PermissionMode
  req(PERMISSION_MODES.has(permissionMode), "options.permissionMode must be bypassPermissions | acceptEdits | plan")

  const n: Partial<NetworkOptions> = o.network ?? {}
  const policy = (n.policy ?? "deny-all") as NetworkOptions["policy"]
  req(NETWORK_PROFILES.has(policy), "options.network.policy must be allow-all | balanced | deny-all")
  const extraHosts = (n.extraHosts ?? []).map((h: unknown) => String(h).trim()).filter(Boolean)
  req(extraHosts.length <= 32, "options.network.extraHosts: at most 32 entries")
  for (const h of extraHosts)
    req(HOST_RULE_RE.test(h), `options.network.extraHosts: "${h}" is not host:port or **.host`)

  const options: SessionOptions = {
    maxTurns,
    permissionMode,
    network: {
      policy,
      allowPackageManagers: n.allowPackageManagers !== false,
      extraHosts,
    },
    idleTtlMinutes: clampInt(o.idleTtlMinutes, defaults.idleTtlMinutes, 5, 1440, "options.idleTtlMinutes"),
    hardTtlMinutes: clampInt(o.hardTtlMinutes, defaults.hardTtlMinutes, 10, 1440, "options.hardTtlMinutes"),
  }

  let resume: ValidatedRequest["resume"]
  if (b.resume) {
    const mode = b.resume.mode
    req(mode === "continue" || mode === "retry", "resume.mode must be continue | retry")
    const taskBranch = str(b.resume.taskBranch, "resume.taskBranch", 200)
    req(
      BRANCH_RE.test(taskBranch) && !taskBranch.includes("..") && taskBranch.startsWith("kiln/"),
      "resume.taskBranch must be a kiln/* branch",
    )
    const history =
      b.resume.history !== undefined ? str(b.resume.history, "resume.history", 256 * 1024, 0) : undefined
    resume = { taskBranch, mode, history: history || undefined }
  }

  return {
    task,
    repo: { owner, name, baseBranch },
    provider: { baseUrl: stripTrailingSlash(baseUrl), token: providerToken, model, smallModel },
    github: { token: githubToken },
    options,
    resume,
  }
}

function clampInt(v: unknown, def: number, min: number, max: number, name: string): number {
  if (v === undefined || v === null) return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ValidationError(`${name} must be an integer in ${min}–${max}`)
  return n
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "")
}

/** Derive the retry branch: kiln/foo-abc → kiln/foo-abc-2 → kiln/foo-abc-3 … */
export function retryBranch(previous: string): string {
  const m = previous.match(/^(.*)-(\d+)$/)
  if (m && Number(m[2]) >= 2) return `${m[1]}-${Number(m[2]) + 1}`
  return `${previous}-2`
}
