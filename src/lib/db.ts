import Dexie, { type Table } from "dexie"
import type { Chat, Message } from "./types"

class AmberDB extends Dexie {
  chats!: Table<Chat, string>
  messages!: Table<Message, string>

  constructor() {
    super("amber")
    this.version(1).stores({
      chats: "id, updatedAt, kind",
      messages: "id, chatId, createdAt",
    })
  }
}

export const db = new AmberDB()

/** Mark any messages left "streaming" by a killed session as interrupted. */
export async function recoverInterrupted(): Promise<void> {
  const stale = await db.messages
    .filter((m) => m.status === "streaming" || m.status === "pending")
    .toArray()
  await Promise.all(
    stale.map((m) =>
      db.messages.update(m.id, {
        status: m.content || m.images?.length ? "interrupted" : "error",
        error: m.content ? undefined : "Interrupted before any output",
      }),
    ),
  )
}

export async function deleteChat(chatId: string): Promise<void> {
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.messages.where("chatId").equals(chatId).delete()
    await db.chats.delete(chatId)
  })
}

export async function chatMessages(chatId: string): Promise<Message[]> {
  const msgs = await db.messages.where("chatId").equals(chatId).toArray()
  return msgs.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Full-text search across message content. Returns one snippet per chat
 * (first match), capped for phone-scale responsiveness.
 */
export async function searchMessages(
  query: string,
): Promise<Map<string, string>> {
  const needle = query.toLowerCase()
  const hits = new Map<string, string>()
  if (!needle) return hits
  const matches = await db.messages
    .filter((m) => (m.content ?? "").toLowerCase().includes(needle))
    .limit(200)
    .toArray()
  for (const m of matches) {
    if (hits.has(m.chatId)) continue
    const lower = m.content.toLowerCase()
    const i = lower.indexOf(needle)
    const start = Math.max(0, i - 28)
    const end = Math.min(m.content.length, i + needle.length + 48)
    const snippet =
      (start > 0 ? "…" : "") +
      m.content.slice(start, end).replace(/\s+/g, " ").trim() +
      (end < m.content.length ? "…" : "")
    hits.set(m.chatId, snippet)
  }
  return hits
}
