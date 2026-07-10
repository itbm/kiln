import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { Effort, ModelRef, Skill } from "@/lib/types"
import { uid } from "@/lib/utils"

export type ThemePref = "system" | "light" | "dark"

export interface Personalization {
  enabled: boolean
  name: string
  role: string
  notes: string
}

interface SettingsState {
  theme: ThemePref
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
  /** null = use the chat's own model for titles */
  titleModel: ModelRef | null
  generateTitles: boolean
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
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
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
    }),
    { name: "amber-settings" },
  ),
)

/** Non-reactive snapshot for use outside React */
export const getSettings = () => useSettings.getState()
