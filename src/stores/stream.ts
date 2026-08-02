import { create } from "zustand"
import type { GenImage, Message, ToolStep } from "@/lib/types"

export interface LiveStream {
  content: string
  reasoning: string
  steps: ToolStep[]
  images: GenImage[]
  startedAt: number
  reasoningMs?: number
  /** code chats: a question the agent is blocked on, and the branch it pushed */
  ask?: Message["ask"]
  branch?: Message["branch"]
}

interface StreamState {
  /** live overlay by messageId while streaming */
  live: Record<string, LiveStream>
  /** chatId -> assistant messageId currently generating */
  generating: Record<string, string>
  controllers: Record<string, AbortController>

  begin: (chatId: string, messageId: string) => AbortController
  update: (messageId: string, patch: Partial<LiveStream>) => void
  end: (chatId: string, messageId: string) => void
  stop: (chatId: string) => void
}

export const useStream = create<StreamState>()((set, get) => ({
  live: {},
  generating: {},
  controllers: {},

  begin: (chatId, messageId) => {
    const controller = new AbortController()
    set((st) => ({
      live: {
        ...st.live,
        [messageId]: {
          content: "",
          reasoning: "",
          steps: [],
          images: [],
          startedAt: Date.now(),
        },
      },
      generating: { ...st.generating, [chatId]: messageId },
      controllers: { ...st.controllers, [messageId]: controller },
    }))
    return controller
  },

  update: (messageId, patch) =>
    set((st) => {
      const cur = st.live[messageId]
      if (!cur) return st
      return { live: { ...st.live, [messageId]: { ...cur, ...patch } } }
    }),

  end: (chatId, messageId) =>
    set((st) => {
      const live = { ...st.live }
      delete live[messageId]
      const generating = { ...st.generating }
      if (generating[chatId] === messageId) delete generating[chatId]
      const controllers = { ...st.controllers }
      delete controllers[messageId]
      return { live, generating, controllers }
    }),

  stop: (chatId) => {
    const msgId = get().generating[chatId]
    if (msgId) get().controllers[msgId]?.abort()
  },
}))

export const isGenerating = (chatId: string | undefined): boolean =>
  !!chatId && !!useStream.getState().generating[chatId]
