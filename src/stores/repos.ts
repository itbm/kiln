import { create } from "zustand"
import { listRepos, type GithubRepo } from "@/lib/github"
import { cleanKey } from "@/lib/utils"
import { getSettings } from "./settings"

/**
 * Cache of the repositories the configured GitHub token can reach. Same shape
 * and lifetime rules as the models cache (stores/models.ts): live-fetched,
 * reused for 15 minutes, and invalidated the moment the token changes so a
 * different account never sees the previous one's list.
 */

const CACHE_KEY = "amber-repos-cache"
/** bump when GithubRepo gains fields, so stale caches refetch immediately */
const CACHE_VERSION = 1
const TTL_MS = 15 * 60_000

interface ReposCache {
  repos: GithubRepo[]
  fetchedAt: number
  /** which token the cache was fetched with (fingerprint, never the token) */
  signature?: string
  v?: number
}

/**
 * A cheap fingerprint of the token, so swapping tokens invalidates the cache.
 * Deliberately not the token itself: the cache is a separate localStorage
 * entry from the settings blob, and there's no reason to copy credentials into
 * a second place that an export or a stray console paste could pick up.
 */
function tokenSignature(): string {
  const t = cleanKey(getSettings().githubToken)
  if (!t) return "none"
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
  return `${t.length}:${(h >>> 0).toString(36)}`
}

function loadCache(): ReposCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const cache = JSON.parse(raw) as ReposCache
      if (cache.v === CACHE_VERSION) return cache
    }
  } catch {
    /* corrupted cache */
  }
  return { repos: [], fetchedAt: 0, v: CACHE_VERSION }
}

interface ReposState extends ReposCache {
  loading: boolean
  error?: string
  refresh: (force?: boolean) => Promise<void>
}

export const useRepos = create<ReposState>()((set, get) => ({
  ...loadCache(),
  loading: false,

  refresh: async (force = false) => {
    const { fetchedAt, loading, signature } = get()
    const sig = tokenSignature()
    if (loading) return
    if (sig === "none") {
      set({ repos: [], error: undefined, signature: sig })
      return
    }
    if (!force && sig === signature && Date.now() - fetchedAt < TTL_MS) return

    set({ loading: true })
    try {
      const repos = await listRepos()
      const next: ReposCache = {
        repos,
        fetchedAt: Date.now(),
        signature: sig,
        v: CACHE_VERSION,
      }
      set({ ...next, loading: false, error: undefined })
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(next))
      } catch {
        /* quota — the in-memory list still works for this session */
      }
    } catch (e) {
      // Keep whatever list we had: a failed refresh shouldn't empty the picker
      // and make it look as though the token lost its grants.
      set({ loading: false, error: (e as Error).message })
    }
  },
}))
