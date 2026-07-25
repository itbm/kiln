import Dexie, { type Table } from "dexie"
import { contentWithoutArtifacts } from "./artifacts"
import type { Chat, Draft, Message } from "./types"

class KilnDB extends Dexie {
  chats!: Table<Chat, string>
  messages!: Table<Message, string>
  drafts!: Table<Draft, string>

  constructor() {
    // db name predates the Kiln rebrand — kept so existing installs keep their data
    super("amber")
    this.version(1).stores({
      chats: "id, updatedAt, kind",
      messages: "id, chatId, createdAt",
    })
    // v2: unsent composer drafts, keyed by chat id (see lib/drafts.ts)
    this.version(2).stores({ drafts: "id" })
  }
}

export const db = new KilnDB()

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
  await db.transaction("rw", db.chats, db.messages, db.drafts, async () => {
    await db.messages.where("chatId").equals(chatId).delete()
    await db.drafts.delete(chatId)
    await db.chats.delete(chatId)
  })
}

export async function chatMessages(chatId: string): Promise<Message[]> {
  const msgs = await db.messages.where("chatId").equals(chatId).toArray()
  return msgs.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Markdown flattened to something worth reading in a one-line snippet:
 * table pipes, list bullets, heading hashes and emphasis all go, so a hit
 * inside a table quotes the words rather than the scaffolding.
 */
function plainText(md: string): string {
  return md
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, "") // table rules
    .replace(/\|/g, " ")
    .replace(/(\*\*|__|`)/g, "")
}

/** A chat's best match: the message it lives in, plus a preview of it. */
export interface SearchHit {
  messageId: string
  snippet: string
}

/**
 * Full-text search across message content. Returns one hit per chat (first
 * match), capped for phone-scale responsiveness. The message id travels
 * with it so opening the result can land on that message rather than at the
 * bottom of the conversation.
 */
export async function searchMessages(
  query: string,
): Promise<Map<string, SearchHit>> {
  const needle = query.toLowerCase()
  const hits = new Map<string, SearchHit>()
  if (!needle) return hits
  const matches = await db.messages
    .filter((m) => (m.content ?? "").toLowerCase().includes(needle))
    .limit(200)
    .toArray()
  for (const m of matches) {
    if (hits.has(m.chatId)) continue
    // quote what the user actually saw: no artefact bodies, no mood tags,
    // no markdown scaffolding
    const clean = plainText(contentWithoutArtifacts(m.content))
    const text = clean.toLowerCase().includes(needle) ? clean : m.content
    const i = text.toLowerCase().indexOf(needle)
    const start = Math.max(0, i - 28)
    const end = Math.min(text.length, i + needle.length + 48)
    const snippet =
      (start > 0 ? "…" : "") +
      text.slice(start, end).replace(/\s+/g, " ").trim() +
      (end < text.length ? "…" : "")
    hits.set(m.chatId, { messageId: m.id, snippet })
  }
  return hits
}
