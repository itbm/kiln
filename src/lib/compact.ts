import type { Chat, Message, ModelRef } from "./types"
import { db } from "./db"
import { buildSystemPrompt } from "./prompts"
import { completeText } from "./providers"
import { contentWithoutArtifacts } from "./artifacts"
import { getSettings } from "@/stores/settings"
import { useTemp } from "@/stores/temp"
import { pip } from "@/pip/bus"

/** chars/4 heuristic — good enough for budgeting, no tokenizer needed */
export function estimateTokens(text: string | undefined): number {
  return text ? Math.ceil(text.length / 4) : 0
}

export function estimateMessageTokens(m: Message): number {
  let t = estimateTokens(m.content) + 4
  for (const a of m.attachments ?? []) {
    if (a.kind === "text") t += estimateTokens(a.text)
    else if (a.kind === "image") t += 1100
    else t += 3000 // pdf: unknown page count, assume a few
  }
  t += (m.images?.length ?? 0) * 1100
  return t
}

/** Estimate of what buildWireHistory would send for this chat right now. */
export function estimateWireTokens(chat: Chat | null, history: Message[]): number {
  const cutoff = chat?.summaryCutoff ?? 0
  let t = estimateTokens(buildSystemPrompt(chat)) + estimateTokens(chat?.summary)
  for (const m of history) {
    if (m.createdAt <= cutoff) continue
    if (m.role === "assistant" && !m.content && !m.images?.length) continue
    t += estimateMessageTokens(m)
  }
  return t
}

const SUMMARIZE_PROMPT = `You compress chat conversations. Write a compact briefing of the conversation below so a model can continue it seamlessly without the original messages. Preserve: the user's goals and preferences, key facts and decisions, constraints, names/numbers/URLs that matter, the state of any code or documents being worked on, and open questions. Use terse markdown bullets, at most 400 words. Output only the briefing.`

const KEEP_RECENT = 4

export interface CompactResult {
  chat: Chat
  summarizedCount: number
}

async function patchChat(chat: Chat, patch: Partial<Chat>): Promise<Chat> {
  if (chat.temporary) useTemp.getState().patchChat(chat.id, patch)
  else await db.chats.update(chat.id, patch)
  return { ...chat, ...patch }
}

/**
 * Summarise everything but the last few messages into chat.summary and move
 * summaryCutoff forward. Visible messages are untouched — compaction only
 * changes what gets sent to the model.
 */
export async function compactChat(
  chat: Chat,
  history: Message[],
  opts: { instructions?: string; keepRecent?: number } = {},
): Promise<CompactResult> {
  const keep = opts.keepRecent ?? KEEP_RECENT
  const cutoff = chat.summaryCutoff ?? 0
  const candidates = history.filter(
    (m) => m.createdAt > cutoff && (m.content || m.attachments?.length),
  )
  const toSummarize = candidates.slice(0, Math.max(candidates.length - keep, 0))
  if (!toSummarize.length) throw new Error("Nothing to compact yet")

  const transcript = toSummarize
    .map((m) => {
      const who = m.role === "user" ? "USER" : "ASSISTANT"
      const text = contentWithoutArtifacts(m.content).slice(0, 1500)
      const files = m.attachments?.map((a) => `[attached: ${a.name}]`).join(" ") ?? ""
      return `${who}: ${files}${files ? " " : ""}${text}`
    })
    .join("\n\n")
    .slice(0, 60_000)

  const s = getSettings()
  const ref: ModelRef | null =
    s.titleModel ??
    (chat.provider && chat.model
      ? { provider: chat.provider, model: chat.model }
      : null)
  if (!ref) throw new Error("No model available for compaction")

  let user = ""
  if (chat.summary) user += `Previous briefing (fold this in):\n${chat.summary}\n\n`
  user += `Conversation:\n${transcript}`
  if (opts.instructions) user += `\n\nExtra focus requested by the user: ${opts.instructions}`

  /* Pip reads the summarising as tidying up and sweeps while it runs (a
     no-op when he isn't on screen); the finally makes sure he stops even
     if the model call throws. */
  pip.sweep(true)
  try {
    let summary = await completeText(ref.provider, {
      model: ref.model,
      effort: "auto",
      messages: [
        { role: "system", content: SUMMARIZE_PROMPT },
        { role: "user", content: user },
      ],
    })
    summary = summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
    if (!summary) throw new Error("Compaction model returned nothing")

    const newCutoff = toSummarize[toSummarize.length - 1].createdAt
    const updated = await patchChat(chat, {
      summary: summary.slice(0, 8000),
      summaryCutoff: newCutoff,
    })
    return { chat: updated, summarizedCount: toSummarize.length }
  } finally {
    pip.sweep(false)
  }
}

/** Drop all prior context (messages stay visible, nothing is sent as history). */
export async function clearContext(chat: Chat): Promise<Chat> {
  return patchChat(chat, { summary: undefined, summaryCutoff: Date.now() })
}
