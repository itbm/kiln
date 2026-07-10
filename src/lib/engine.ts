import type {
  Attachment,
  Chat,
  Effort,
  Message,
  ModelRef,
  ToolStep,
  WireMessage,
} from "./types"
import { db } from "./db"
import { uid } from "./utils"
import { buildSystemPrompt, TITLE_PROMPT } from "./prompts"
import { completeText, streamChat } from "./providers"
import { getEnabledTools, executeTool } from "./tools"
import { contentWithoutArtifacts } from "./artifacts"
import { notifyChatDone, acquireWakeLock, releaseWakeLock } from "./notify"
import { useStream } from "@/stores/stream"
import { useTemp } from "@/stores/temp"
import { useSettings, getSettings } from "@/stores/settings"
import { findModel } from "@/stores/models"

const MAX_TOOL_ROUNDS = 8
const PERSIST_INTERVAL = 700

async function persistMessage(msg: Message, temporary: boolean) {
  if (temporary) useTemp.getState().putMessage({ ...msg })
  else await db.messages.put({ ...msg })
}

async function patchChat(chat: Chat, patch: Partial<Chat>) {
  if (chat.temporary) useTemp.getState().patchChat(chat.id, patch)
  else await db.chats.update(chat.id, patch)
}

function attachmentsToWire(msg: Message): WireMessage {
  let content = msg.content
  const images: string[] = []
  const files: { name: string; dataUrl: string }[] = []
  for (const a of msg.attachments ?? []) {
    if (a.kind === "image" && a.dataUrl) images.push(a.dataUrl)
    else if (a.kind === "pdf" && a.dataUrl)
      files.push({ name: a.name, dataUrl: a.dataUrl })
    else if (a.kind === "text" && a.text)
      content += `\n\n<attachment name="${a.name}">\n${a.text}\n</attachment>`
  }
  return { role: "user", content, images, files }
}

export function buildWireHistory(
  chat: Chat | null,
  history: Message[],
): WireMessage[] {
  const wire: WireMessage[] = [
    { role: "system", content: buildSystemPrompt(chat) },
  ]
  for (const m of history) {
    if (m.role === "user") wire.push(attachmentsToWire(m))
    else if (m.content || m.images?.length)
      wire.push({ role: "assistant", content: m.content })
  }
  return wire
}

export interface SendOptions {
  chat: Chat
  history: Message[]
  text: string
  attachments: Attachment[]
  modelRef: ModelRef
  effort: Effort
}

/** Create + persist the user message, then run the assistant turn. */
export async function sendUserMessage(opts: SendOptions): Promise<void> {
  const { chat, text, attachments, modelRef, effort } = opts
  const now = Date.now()
  const userMsg: Message = {
    id: uid(),
    chatId: chat.id,
    role: "user",
    content: text,
    attachments: attachments.length ? attachments : undefined,
    status: "done",
    createdAt: now,
  }
  await persistMessage(userMsg, !!chat.temporary)
  await patchChat(chat, {
    updatedAt: now,
    provider: modelRef.provider,
    model: modelRef.model,
    effort,
  })
  useSettings.getState().set(
    chat.kind === "image"
      ? { lastImageModel: modelRef }
      : { lastModel: modelRef, lastEffort: effort },
  )
  const history = [...opts.history, userMsg]
  await runAssistantTurn(chat, history, modelRef, effort)
}

/** Re-run generation for the tail of the conversation (regenerate). */
export async function regenerateLast(
  chat: Chat,
  history: Message[],
  modelRef: ModelRef,
  effort: Effort,
): Promise<void> {
  const last = history[history.length - 1]
  if (last?.role === "assistant") {
    history = history.slice(0, -1)
    if (chat.temporary) {
      useTemp.setState((s) => ({
        messages: {
          ...s.messages,
          [chat.id]: (s.messages[chat.id] ?? []).filter(
            (m) => m.id !== last.id,
          ),
        },
      }))
    } else {
      await db.messages.delete(last.id)
    }
  }
  await patchChat(chat, {
    provider: modelRef.provider,
    model: modelRef.model,
    effort,
  })
  useSettings.getState().set({ lastModel: modelRef, lastEffort: effort })
  await runAssistantTurn(chat, history, modelRef, effort)
}

async function runAssistantTurn(
  chat: Chat,
  history: Message[],
  modelRef: ModelRef,
  effort: Effort,
): Promise<void> {
  const temporary = !!chat.temporary
  const stream = useStream.getState()
  const isImage = chat.kind === "image"
  const modelInfo = findModel(modelRef)

  const msg: Message = {
    id: uid(),
    chatId: chat.id,
    role: "assistant",
    content: "",
    provider: modelRef.provider,
    model: modelRef.model,
    modelName: modelInfo?.name,
    effort,
    status: "streaming",
    createdAt: Date.now(),
  }
  await persistMessage(msg, temporary)
  const controller = stream.begin(chat.id, msg.id)
  void acquireWakeLock()

  const wire = buildWireHistory(chat, history)
  const tools =
    !isImage && (modelInfo?.tools ?? true) ? getEnabledTools() : []

  let content = ""
  let reasoning = ""
  let reasoningStart = 0
  let reasoningMs: number | undefined
  const steps: ToolStep[] = []
  const images: { id: string; dataUrl: string }[] = []
  let lastPersist = Date.now()
  let finalStatus: Message["status"] = "done"
  let errorText: string | undefined

  const snapshot = (): Message => ({
    ...msg,
    content,
    reasoning: reasoning || undefined,
    reasoningMs,
    steps: steps.length ? steps.map((s) => ({ ...s })) : undefined,
    images: images.length ? [...images] : undefined,
  })

  // Throttle store updates (~12fps) so long streams don't re-render per token
  let lastPush = 0
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  const doPush = () => {
    lastPush = Date.now()
    useStream.getState().update(msg.id, {
      content,
      reasoning,
      steps: steps.map((s) => ({ ...s })),
      images: [...images],
      reasoningMs,
    })
  }
  const pushLive = (force = false) => {
    if (force || Date.now() - lastPush > 80) {
      clearTimeout(pushTimer)
      pushTimer = undefined
      doPush()
    } else if (!pushTimer) {
      pushTimer = setTimeout(doPush, 90)
    }
  }

  const maybePersist = async (force = false) => {
    if (!force && Date.now() - lastPersist < PERSIST_INTERVAL) return
    lastPersist = Date.now()
    await persistMessage({ ...snapshot(), status: "streaming" }, temporary)
  }

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let toolCalls: import("./types").WireToolCall[] = []

      for await (const ev of streamChat(modelRef.provider, {
        model: modelRef.model,
        messages: wire,
        effort,
        tools: tools.length ? tools : undefined,
        imageOutput: isImage,
        signal: controller.signal,
      })) {
        if (ev.type === "reasoning") {
          if (!reasoning) reasoningStart = Date.now()
          reasoning += ev.text
        } else if (ev.type === "text") {
          if (reasoningStart && reasoningMs === undefined)
            reasoningMs = Date.now() - reasoningStart
          content += ev.text
        } else if (ev.type === "image") {
          images.push({ id: uid(), dataUrl: ev.dataUrl })
        } else if (ev.type === "tool_calls") {
          toolCalls = ev.calls
        }
        pushLive()
        await maybePersist()
      }

      if (!toolCalls.length) break

      // Record the assistant tool-call turn, execute, feed results back.
      wire.push({ role: "assistant", content, toolCalls })
      content = ""
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.args || "{}")
        } catch {
          /* leave empty */
        }
        const step: ToolStep = {
          id: call.id,
          name: call.name,
          args,
          status: "running",
        }
        steps.push(step)
        pushLive(true)
        try {
          const result = await executeTool(call.name, args, controller.signal)
          step.result = result
          step.status = "done"
          wire.push({
            role: "tool",
            content: result,
            toolCallId: call.id,
            toolName: call.name,
          })
        } catch (e) {
          step.result = e instanceof Error ? e.message : "Tool failed"
          step.status = "error"
          wire.push({
            role: "tool",
            content: `Error: ${step.result}`,
            toolCallId: call.id,
            toolName: call.name,
          })
        }
        pushLive(true)
        await maybePersist(true)
      }
    }
  } catch (e) {
    if (controller.signal.aborted) {
      finalStatus = "stopped"
    } else {
      finalStatus = "error"
      errorText = e instanceof Error ? e.message : String(e)
    }
  }

  clearTimeout(pushTimer)
  if (reasoningStart && reasoningMs === undefined)
    reasoningMs = Date.now() - reasoningStart

  const finalMsg: Message = {
    ...snapshot(),
    status: finalStatus,
    error: errorText,
  }
  await persistMessage(finalMsg, temporary)
  await patchChat(chat, { updatedAt: Date.now() })
  useStream.getState().end(chat.id, msg.id)
  if (!Object.keys(useStream.getState().generating).length) releaseWakeLock()

  const preview =
    finalStatus === "error"
      ? `Error: ${errorText}`
      : contentWithoutArtifacts(content) || (images.length ? "Image ready" : "")
  void notifyChatDone(chat.id, chat.title, preview)

  if (
    finalStatus === "done" &&
    !chat.titleIsManual &&
    !chat.titleGenerated &&
    chat.kind === "chat" &&
    getSettings().generateTitles
  ) {
    void generateTitle(chat, history, finalMsg)
  }
}

async function generateTitle(
  chat: Chat,
  history: Message[],
  assistant: Message,
): Promise<void> {
  try {
    const s = getSettings()
    const ref: ModelRef = s.titleModel ?? {
      provider: assistant.provider!,
      model: assistant.model!,
    }
    const firstUser = history.find((m) => m.role === "user")
    const convo = `USER: ${(firstUser?.content ?? "").slice(0, 1200)}\n\nASSISTANT: ${contentWithoutArtifacts(assistant.content).slice(0, 800)}`
    let title = await completeText(ref.provider, {
      model: ref.model,
      effort: "auto",
      messages: [
        { role: "system", content: TITLE_PROMPT },
        { role: "user", content: convo },
      ],
    })
    title = title
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()!
      ?.replace(/^["'#\s]+|["'.\s]+$/g, "")
      .slice(0, 60)
    if (title) await patchChat(chat, { title, titleGenerated: true })
  } catch {
    /* title generation is best-effort */
  }
}
