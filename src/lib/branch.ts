import { db } from "./db"
import type { Chat, Message } from "./types"
import { uid } from "./utils"
import { useTemp } from "@/stores/temp"

/**
 * Fork a conversation at one reply.
 *
 * Regenerating mid-chat replaces everything after the reply; this is the
 * non-destructive door out of the same corner — the original is untouched and
 * you carry on from that point in a copy. Message ids are new (they key
 * IndexedDB) but createdAt is preserved, since ordering, timestamps and the
 * compaction cutoff all read it.
 *
 * Returns the new chat's id.
 */
export async function branchChat(
  chat: Chat,
  messages: Message[],
  upTo: Message,
): Promise<string> {
  const end = messages.findIndex((m) => m.id === upTo.id)
  if (end < 0) throw new Error("Can't branch from a message that isn't in this chat")
  const kept = messages.slice(0, end + 1)
  const id = uid()

  // "X (branch)" branched again stays "X (branch)" rather than stacking
  const base = chat.title.replace(/\s*\(branch\)\s*$/i, "").trim()
  const cutoff = chat.summaryCutoff ?? 0
  // a summary that covers messages the fork doesn't have would hide all of it
  const keepSummary = cutoff > 0 && cutoff <= kept[kept.length - 1].createdAt

  const fork: Chat = {
    id,
    kind: chat.kind,
    title: `${base || "Chat"} (branch)`,
    titleIsManual: true,
    createdAt: chat.createdAt,
    updatedAt: Date.now(),
    provider: chat.provider,
    model: chat.model,
    effort: chat.effort,
    skillIds: chat.skillIds,
    temporary: chat.temporary,
    summary: keepSummary ? chat.summary : undefined,
    summaryCutoff: keepSummary ? chat.summaryCutoff : undefined,
  }
  const copies: Message[] = kept.map((m) => ({ ...m, id: uid(), chatId: id }))

  // a ghost chat branches into another ghost chat — nothing reaches the disk
  if (chat.temporary) {
    const temp = useTemp.getState()
    temp.putChat(fork)
    for (const m of copies) temp.putMessage(m)
    return id
  }
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.chats.add(fork)
    await db.messages.bulkAdd(copies)
  })
  return id
}
