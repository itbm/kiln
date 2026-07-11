import { create } from "zustand"
import type { ModelInfo, ModelRef, ProviderId } from "@/lib/types"
import { fetchOpenRouterModels } from "@/lib/providers/openrouter"
import { fetchOllamaModels } from "@/lib/providers/ollama"
import { getSettings } from "./settings"

const CACHE_KEY = "amber-models-cache"
/** bump when ModelInfo gains fields, so stale caches refetch immediately */
const CACHE_VERSION = 2

interface ModelsCache {
  openrouter: ModelInfo[]
  ollama: ModelInfo[]
  fetchedAt: number
  /** which keys/endpoint the cache was fetched with */
  signature?: string
  v?: number
}

/** Models are only fetched for providers with a key configured. */
export function modelsSignature(): string {
  const s = getSettings()
  return `${s.openrouterKey ? 1 : 0}:${s.ollamaKey ? 1 : 0}:${s.ollamaBaseUrl}`
}

function loadCache(): ModelsCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const cache = JSON.parse(raw) as ModelsCache
      if (cache.v === CACHE_VERSION) return cache
    }
  } catch {
    /* corrupted cache */
  }
  return { openrouter: [], ollama: [], fetchedAt: 0, v: CACHE_VERSION }
}

interface ModelsState extends ModelsCache {
  loading: boolean
  errors: Partial<Record<ProviderId, string>>
  refresh: (force?: boolean) => Promise<void>
}

export const useModels = create<ModelsState>()((set, get) => ({
  ...loadCache(),
  loading: false,
  errors: {},

  refresh: async (force = false) => {
    const { fetchedAt, loading, signature } = get()
    const s = getSettings()
    const sig = modelsSignature()
    if (loading) return
    // Live-fetch, but avoid hammering: reuse a cache younger than 15 min —
    // unless the configured keys/endpoint changed since it was fetched.
    if (!force && sig === signature && Date.now() - fetchedAt < 15 * 60_000)
      return
    set({ loading: true })
    const errors: Partial<Record<ProviderId, string>> = {}

    const [or, ol] = await Promise.all([
      s.openrouterKey
        ? fetchOpenRouterModels().catch((e) => {
            errors.openrouter = e.message
            return null
          })
        : Promise.resolve(null),
      s.ollamaKey
        ? fetchOllamaModels().catch((e) => {
            errors.ollama = e.message
            return null
          })
        : Promise.resolve(null),
    ])

    const next: ModelsCache = {
      // on fetch failure keep the previous list; without a key show nothing
      openrouter: s.openrouterKey ? (or ?? get().openrouter) : [],
      ollama: s.ollamaKey ? (ol ?? get().ollama) : [],
      fetchedAt: Date.now(),
      signature: sig,
      v: CACHE_VERSION,
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(next))
    } catch {
      /* storage full — cache is optional */
    }
    set({ ...next, loading: false, errors })
  },
}))

export function allModels(): ModelInfo[] {
  const st = useModels.getState()
  return [...st.ollama, ...st.openrouter]
}

export function findModel(ref: ModelRef | null): ModelInfo | undefined {
  if (!ref) return undefined
  return allModels().find(
    (m) => m.provider === ref.provider && m.id === ref.model,
  )
}

export function displayModelName(ref: ModelRef | null): string {
  if (!ref) return "Choose model"
  const info = findModel(ref)
  if (info) return info.name
  return ref.model.split("/").pop() ?? ref.model
}
