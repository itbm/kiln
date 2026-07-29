import type { Chat, Message } from "./types"
import { db, chatMessages } from "./db"
import { chatToMarkdown } from "./transcript"
import { getSettings } from "@/stores/settings"

export interface ChatExport {
  /** format id — "amber" is the legacy value, still accepted on import */
  app: "kiln" | "amber"
  version: 1
  exportedAt: number
  chats: Chat[]
  messages: Message[]
}

export async function exportChatFile(chat: Chat): Promise<void> {
  const messages = await chatMessages(chat.id)
  const payload: ChatExport = {
    app: "kiln",
    version: 1,
    exportedAt: Date.now(),
    chats: [chat],
    messages,
  }
  downloadJson(payload, `kiln-chat-${slug(chat.title)}.json`)
}

/*
 * Getting a conversation out in a form a person can read. All three take the
 * messages already on screen and build the transcript synchronously: Safari
 * only allows share()/clipboard writes while the tap that asked for them is
 * still the current task, so there is nothing to await first.
 */

export function chatMarkdownName(chat: Chat): string {
  return `kiln-chat-${slug(chat.title)}.md`
}

export function downloadChatMarkdown(chat: Chat, messages: Message[]): void {
  download(
    new Blob([chatToMarkdown(chat, messages)], { type: "text/markdown" }),
    chatMarkdownName(chat),
  )
}

export async function copyChatMarkdown(
  chat: Chat,
  messages: Message[],
): Promise<void> {
  await navigator.clipboard.writeText(chatToMarkdown(chat, messages))
}

/** Does this device have a share sheet to send the transcript to? */
export function canShare(): boolean {
  return typeof navigator.share === "function"
}

/** Hand the transcript to the OS share sheet. False if the user backed out. */
export async function shareChatMarkdown(
  chat: Chat,
  messages: Message[],
): Promise<boolean> {
  const md = chatToMarkdown(chat, messages)
  const file = new File([md], chatMarkdownName(chat), { type: "text/markdown" })
  try {
    await navigator.share(
      navigator.canShare?.({ files: [file] })
        ? { files: [file], title: chat.title }
        : { title: chat.title, text: md },
    )
    return true
  } catch (e) {
    // dismissing the sheet is not a failure worth shouting about
    if (e instanceof DOMException && e.name === "AbortError") return false
    throw e
  }
}

export async function exportAllData(): Promise<void> {
  const payload: ChatExport = {
    app: "kiln",
    version: 1,
    exportedAt: Date.now(),
    chats: await db.chats.toArray(),
    messages: await db.messages.toArray(),
  }
  downloadJson(payload, `kiln-backup-${new Date().toISOString().slice(0, 10)}.json`)
}

function isValidChat(c: unknown): c is Chat {
  const v = c as Chat
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.title === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  )
}

function isValidMessage(m: unknown): m is Message {
  const v = m as Message
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.chatId === "string" &&
    (v.role === "user" || v.role === "assistant") &&
    typeof v.content === "string" &&
    typeof v.createdAt === "number"
  )
}

/** Rows land straight in Dexie and are read back by every render, so a
 *  malformed one doesn't fail here — it fails later, somewhere unrelated.
 *  Anything that doesn't hold up is counted and left out. */
export async function importData(
  file: File,
): Promise<{ chats: number; skipped: number }> {
  let parsed: ChatExport
  try {
    parsed = JSON.parse(await file.text()) as ChatExport
  } catch {
    throw new Error("Not a Kiln export file (invalid JSON)")
  }
  if (
    (parsed.app !== "kiln" && parsed.app !== "amber") ||
    !Array.isArray(parsed.chats)
  )
    throw new Error("Not a Kiln export file")
  const rawChats = parsed.chats
  const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : []
  const chats = rawChats.filter(isValidChat).map((c) => ({
    ...c,
    // exports predating chat kinds carry none; ghost chats were never on disk
    kind: c.kind === "image" ? ("image" as const) : ("chat" as const),
    temporary: undefined,
  }))
  const messages = rawMessages.filter(isValidMessage).map((m) => ({
    ...m,
    // nothing is in flight in a file — a status that says otherwise would
    // leave the reply spinning forever
    status:
      m.status === "done" || m.status === "error" || m.status === "stopped"
        ? m.status
        : ("interrupted" as const),
    cloudJobId: undefined,
  }))
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.chats.bulkPut(chats)
    await db.messages.bulkPut(messages)
  })
  return {
    chats: chats.length,
    skipped:
      rawChats.length - chats.length + (rawMessages.length - messages.length),
  }
}

/**
 * Push a chat to a user-configured server. The endpoint contract is
 * intentionally simple so any future backend can implement it:
 *   POST {syncUrl}/chats   body: ChatExport   auth: Bearer {syncToken}
 */
export async function uploadChatToServer(chat: Chat): Promise<void> {
  const { syncUrl, syncToken } = getSettings()
  if (!syncUrl) throw new Error("No server URL configured in Settings → Server")
  const messages = await chatMessages(chat.id)
  const res = await fetch(`${syncUrl.replace(/\/$/, "")}/chats`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(syncToken ? { Authorization: `Bearer ${syncToken}` } : {}),
    },
    body: JSON.stringify({
      app: "kiln",
      version: 1,
      exportedAt: Date.now(),
      chats: [chat],
      messages,
    } satisfies ChatExport),
  })
  if (!res.ok) throw new Error(`Server responded HTTP ${res.status}`)
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chat"
  )
}

function downloadJson(data: unknown, filename: string): void {
  download(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    filename,
  )
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
