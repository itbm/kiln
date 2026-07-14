import { create } from "zustand"

export type AgentConnState = "connecting" | "live" | "offline"

/** UI-visible connection state per agent chat; sockets live in lib/agent/runtime. */
interface AgentStoreState {
  conn: Record<string, AgentConnState>
  setConn: (chatId: string, state: AgentConnState | null) => void
}

export const useAgentConn = create<AgentStoreState>()((set) => ({
  conn: {},
  setConn: (chatId, state) =>
    set((st) => {
      const conn = { ...st.conn }
      if (state === null) delete conn[chatId]
      else conn[chatId] = state
      return { conn }
    }),
}))
