import { cleanKey, uid } from "./utils"
import { getSettings } from "@/stores/settings"

/**
 * GitHub client for code chats. Everything here runs **on the device**:
 * api.github.com sends permissive CORS headers, so listing repositories and
 * branches needs no relay and no server involvement — the token never leaves
 * the phone for this. (It does travel to the sandbox when a coding turn runs;
 * that path lives in lib/forge.ts.)
 *
 * Auth is a fine-grained personal access token stored like every other key,
 * in `amber-settings`. It needs Contents: read/write on the repositories you
 * want coded in, plus Metadata: read (which GitHub forces anyway).
 */

const BASE = "https://api.github.com"

/** Enough pages to cover any plausible account without ever looping forever. */
const MAX_PAGES = 10
const PER_PAGE = 100

export interface GithubRepo {
  owner: string
  name: string
  /** "owner/name" — the form the UI shows and `CodeRepo` is built from */
  fullName: string
  defaultBranch: string
  private: boolean
  description?: string
  /** last push, ms — the list is sorted by this */
  pushedAt: number
}

export interface GithubBranch {
  name: string
  /** branch protection is on, so pushing to it may be refused */
  protected: boolean
}

/** The token isn't configured, so code chats can't be offered at all. */
export class NoGithubToken extends Error {
  constructor() {
    super("No GitHub token configured — add one in Settings → Providers")
    this.name = "NoGithubToken"
  }
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    // Pinning the API version keeps a future default bump from changing
    // response shapes under us.
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

function requireToken(): string {
  const token = cleanKey(getSettings().githubToken)
  if (!token) throw new NoGithubToken()
  return token
}

/**
 * One request, with the failure modes spelled out. GitHub's error bodies are
 * usually helpful, so surface them rather than a bare status — a scope problem
 * and a typo'd repository name are both 404 and need telling apart.
 */
async function gh(path: string, token: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    headers: headers(token),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  })
  if (res.ok) return res

  let detail = ""
  try {
    const j = await res.json()
    if (j?.message) detail = j.message
  } catch {
    /* no body worth reading */
  }

  // Rate limiting arrives as 403 or 429 and must not be reported as a
  // permissions problem. Three signals, because no single one is dependable:
  // GitHub lists the X-RateLimit-* headers in Access-Control-Expose-Headers so
  // a browser can read them, but a reverse proxy in front of us may strip
  // them; secondary ("abuse detection") limits send Retry-After and leave the
  // primary count untouched; the message body is always readable.
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("X-RateLimit-Remaining")
    const retryAfter = Number(res.headers.get("Retry-After"))
    const isLimited =
      remaining === "0" || retryAfter > 0 || /rate limit/i.test(detail)
    if (isLimited) {
      const reset = Number(res.headers.get("X-RateLimit-Reset")) * 1000
      const secs = retryAfter > 0 ? retryAfter : reset ? (reset - Date.now()) / 1000 : 0
      const mins = secs > 0 ? Math.max(1, Math.ceil(secs / 60)) : 0
      const when = mins
        ? ` — try again in about ${mins} minute${mins === 1 ? "" : "s"}`
        : " — try again shortly"
      // Secondary limits are per-burst rather than per-hour, so name which one
      // was hit: the advice differs (slow down vs wait for the window).
      const kind = /secondary/i.test(detail) ? "secondary rate limit" : "rate limit"
      throw new Error(`GitHub ${kind} reached${when}`)
    }
  }
  if (res.status === 401)
    throw new Error(
      `GitHub rejected the token${detail ? ` — ${detail}` : ""}. Check it hasn't expired, and re-paste it in Settings.`,
    )
  if (res.status === 403)
    throw new Error(
      `GitHub refused the request${detail ? ` — ${detail}` : ""}. A fine-grained token needs Contents access to this repository.`,
    )
  if (res.status === 404)
    throw new Error(
      "Not found — either it doesn't exist, or this token has no access to it. Fine-grained tokens only see repositories you granted them.",
    )
  throw new Error(`GitHub: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`)
}

/**
 * Page until a short page arrives. Simpler than parsing the Link header and
 * equivalent for these endpoints, since both return a plain array; the page cap
 * is a backstop, not an expected limit.
 */
async function ghPaged<T>(path: string, token: string): Promise<T[]> {
  const out: T[] = []
  const join = path.includes("?") ? "&" : "?"
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await gh(`${path}${join}per_page=${PER_PAGE}&page=${page}`, token)
    const batch = (await res.json()) as T[]
    if (!Array.isArray(batch)) break
    out.push(...batch)
    if (batch.length < PER_PAGE) break
  }
  return out
}

function toRepo(r: any): GithubRepo {
  return {
    owner: r.owner?.login ?? "",
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? "main",
    private: !!r.private,
    description: r.description ?? undefined,
    pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : 0,
  }
}

/**
 * Every repository the token can reach, most recently pushed first — the order
 * the picker wants, since the repo you mean is nearly always one you touched
 * recently.
 */
export async function listRepos(): Promise<GithubRepo[]> {
  const token = requireToken()
  const raw = await ghPaged<any>("/user/repos?sort=pushed&direction=desc", token)
  return raw.map(toRepo)
}

export async function getRepo(
  owner: string,
  name: string,
): Promise<GithubRepo> {
  const token = requireToken()
  const res = await gh(`/repos/${owner}/${name}`, token)
  return toRepo(await res.json())
}

export async function listBranches(
  owner: string,
  name: string,
): Promise<GithubBranch[]> {
  const token = requireToken()
  const raw = await ghPaged<any>(`/repos/${owner}/${name}/branches`, token)
  return raw.map((b) => ({ name: b.name, protected: !!b.protected }))
}

/**
 * Validate a token and report who it belongs to. Shaped like
 * `checkOpenRouterKey` so Settings can offer the same "test this key"
 * affordance — takes the candidate rather than reading settings, so it can
 * check a value before it's saved.
 */
export async function checkGithubToken(token: string): Promise<string> {
  const t = cleanKey(token)
  if (!t)
    throw new Error(
      "the field only holds whitespace or invisible characters — copy the token from github.com again",
    )
  const res = await gh("/user", t)
  const json = await res.json()
  const login = json.login ?? "OK"
  // A fine-grained token with no repository grants authenticates fine and then
  // fails on the first real call, which reads as a bug rather than a setup
  // step. Catch it here instead.
  try {
    const repos = await gh("/user/repos?per_page=1", t)
    const list = await repos.json()
    if (Array.isArray(list) && list.length === 0)
      return `${login} — but this token can't see any repositories yet: grant it Contents access under Repository access`
  } catch {
    /* the /user call already proved the token; don't fail the check on this */
  }
  return login
}

/** Is a token configured at all? Gates the Code chat entry point. */
export function hasGithubToken(): boolean {
  return !!cleanKey(getSettings().githubToken)
}

/**
 * The branch the agent commits to. Never the branch the user picked — a code
 * chat must not write to something someone else builds from. Dated so a list
 * of them reads chronologically, with a short random tail because a repo can
 * hold several chats' worth in a day.
 */
export function suggestWorkBranch(): string {
  const d = new Date()
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("")
  return `kiln/${stamp}-${uid().slice(0, 6)}`
}

/** GitHub's compare view for a pushed branch — what the branch card links to. */
export function compareUrl(
  owner: string,
  name: string,
  baseBranch: string,
  workBranch: string,
): string {
  return `https://github.com/${owner}/${name}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(workBranch)}?expand=1`
}
