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

export async function importData(file: File): Promise<number> {
  const parsed = JSON.parse(await file.text()) as ChatExport
  if (
    (parsed.app !== "kiln" && parsed.app !== "amber") ||
    !Array.isArray(parsed.chats)
  )
    throw new Error("Not a Kiln export file")
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.chats.bulkPut(parsed.chats)
    await db.messages.bulkPut(parsed.messages)
  })
  return parsed.chats.length
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
