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

  /** ---- agent runner (Code tab) — all optional, empty = feature off ---- */
  /** runner base URL; "" = same origin at /agent (the bundled nginx relay) */
  agentRunnerUrl: string
  agentRunnerToken: string
  /** fine-grained GitHub PAT sent per session, never stored server-side */
  agentGithubToken: string
  /** 256-bit hex key for the runner's encrypted session journal (§5.7) */
  agentJournalKey: string
  lastAgentModel: ModelRef | null
  lastAgentRepo: string
  lastAgentBaseBranch: string
  agentPermissionMode: "bypassPermissions" | "acceptEdits" | "plan"
  agentNetworkPolicy: "allow-all" | "balanced" | "deny-all"
  agentAllowPackageManagers: boolean
  agentExtraHosts: string

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

      agentRunnerUrl: "",
      agentRunnerToken: "",
      agentGithubToken: "",
      agentJournalKey: "",
      lastAgentModel: null,
      lastAgentRepo: "",
      lastAgentBaseBranch: "main",
      agentPermissionMode: "bypassPermissions",
      agentNetworkPolicy: "deny-all",
      agentAllowPackageManagers: true,
      agentExtraHosts: "",

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
    { name: "amber-settings" },
  ),
)

/** Non-reactive snapshot for use outside React */
export const getSettings = () => useSettings.getState()
