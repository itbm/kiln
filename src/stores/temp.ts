import { create } from "zustand"
import type { Chat, Message } from "@/lib/types"
import { db } from "@/lib/db"

/** Temporary chats live here (memory only) and vanish on reload. */
interface TempState {
  chats: Record<string, Chat>
  messages: Record<string, Message[]>

  putChat: (chat: Chat) => void
  patchChat: (id: string, patch: Partial<Chat>) => void
  putMessage: (msg: Message) => void
  deleteMessages: (chatId: string, ids: string[]) => void
  remove: (id: string) => void
  /** persist a temporary chat into IndexedDB */
  saveToHistory: (id: string) => Promise<void>
}

export const useTemp = create<TempState>()((set, get) => ({
  chats: {},
  messages: {},

  putChat: (chat) =>
    set((st) => ({
      chats: { ...st.chats, [chat.id]: chat },
      messages: { ...st.messages, [chat.id]: st.messages[chat.id] ?? [] },
    })),

  patchChat: (id, patch) =>
    set((st) => {
      const cur = st.chats[id]
      if (!cur) return st
      return { chats: { ...st.chats, [id]: { ...cur, ...patch } } }
    }),

  putMessage: (msg) =>
    set((st) => {
      const list = st.messages[msg.chatId] ?? []
      const i = list.findIndex((m) => m.id === msg.id)
      const next =
        i >= 0
          ? [...list.slice(0, i), msg, ...list.slice(i + 1)]
          : [...list, msg]
      return { messages: { ...st.messages, [msg.chatId]: next } }
    }),

  deleteMessages: (chatId, ids) =>
    set((st) => ({
      messages: {
        ...st.messages,
        [chatId]: (st.messages[chatId] ?? []).filter(
          (m) => !ids.includes(m.id),
        ),
      },
    })),

  remove: (id) =>
    set((st) => {
      const chats = { ...st.chats }
      const messages = { ...st.messages }
      delete chats[id]
      delete messages[id]
      return { chats, messages }
    }),

  saveToHistory: async (id) => {
    const chat = get().chats[id]
    const msgs = get().messages[id] ?? []
    if (!chat) return
    await db.transaction("rw", db.chats, db.messages, async () => {
      await db.chats.put({ ...chat, temporary: false })
      await db.messages.bulkPut(msgs)
    })
    get().remove(id)
  },
}))
