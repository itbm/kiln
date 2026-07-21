import { create } from "zustand"
import { persist } from "zustand/middleware"
import { DEFAULT_THEME_ID } from "@/lib/themes"
import type { Effort, ModelRef, Skill } from "@/lib/types"
import { cleanKey, uid } from "@/lib/utils"

export type ThemePref = "system" | "light" | "dark"

export interface Personalization {
  enabled: boolean
  name: string
  role: string
  notes: string
}

interface SettingsState {
  theme: ThemePref
  /** app theme id from the THEMES registry (src/lib/themes) */
  appTheme: string
  /** show Pip the stuntflame, in themes that include him */
  pipEnabled: boolean
  openrouterKey: string
  ollamaKey: string
  /** "/api/ollama" (same-origin proxy, default) or a direct URL (e.g. LAN Ollama) */
  ollamaBaseUrl: string
  tavilyKey: string
  /** null = built-in default */
  systemPrompt: string | null
  personalization: Personalization
  skills: Skill[]
  lastModel: ModelRef | null
  lastEffort: Effort
  lastImageModel: ModelRef | null
  /** null = use the chat's own model (utility model: titles + compaction) */
  titleModel: ModelRef | null
  generateTitles: boolean
  autoCompact: boolean
  /** "provider:modelId" keys */
  favoriteModels: string[]
  notifications: boolean
  keepAwake: boolean
  webSearchEnabled: boolean
  webFetchEnabled: boolean
  syncUrl: string
  syncToken: string

  set: (patch: Partial<SettingsState>) => void
  addSkill: (s: Omit<Skill, "id">) => void
  updateSkill: (id: string, patch: Partial<Skill>) => void
  removeSkill: (id: string) => void
  toggleFavoriteModel: (key: string) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      appTheme: DEFAULT_THEME_ID,
      pipEnabled: true,
      openrouterKey: "",
      ollamaKey: "",
      ollamaBaseUrl: "/api/ollama",
      tavilyKey: "",
      systemPrompt: null,
      personalization: { enabled: true, name: "", role: "", notes: "" },
      skills: [],
      lastModel: null,
      lastEffort: "auto",
      lastImageModel: null,
      titleModel: null,
      generateTitles: true,
      autoCompact: true,
      favoriteModels: [],
      notifications: false,
      keepAwake: false,
      webSearchEnabled: true,
      webFetchEnabled: true,
      syncUrl: "",
      syncToken: "",

      set: (patch) => set(patch),
      addSkill: (s) =>
        set((st) => ({ skills: [...st.skills, { ...s, id: uid() }] })),
      updateSkill: (id, patch) =>
        set((st) => ({
          skills: st.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        })),
      removeSkill: (id) =>
        set((st) => ({ skills: st.skills.filter((s) => s.id !== id) })),
      toggleFavoriteModel: (key) =>
        set((st) => ({
          favoriteModels: st.favoriteModels.includes(key)
            ? st.favoriteModels.filter((k) => k !== key)
            : [...st.favoriteModels, key],
        })),
    }),
    {
      name: "amber-settings",
      version: 1,
      // v1: keys saved before cleanKey handled quotes/prefixes (or via old
      // builds that stored raw input) get sanitised once on load, so a
      // whitespace-only or quote-wrapped key can't linger as "configured"
      migrate: (persisted) => {
        const st = persisted as Record<string, unknown>
        for (const f of ["openrouterKey", "ollamaKey", "tavilyKey"] as const)
          if (typeof st[f] === "string") st[f] = cleanKey(st[f] as string)
        return st
      },
    },
  ),
)

/* Each open copy of the app (installed PWA, browser tabs) holds its own
   in-memory store. Without this, a key saved in one instance keeps its old
   value in the others until they reload — key tests and chats there keep
   using the stale key. The event only fires in the instances that didn't
   write, so the writer is never disturbed. */
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (!e.key || e.key === "amber-settings")
      void useSettings.persist.rehydrate()
  })

/** Non-reactive snapshot for use outside React */
export const getSettings = () => useSettings.getState()
