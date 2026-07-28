import type {
  Attachment,
  Chat,
  Effort,
  Message,
  ModelRef,
  ToolDef,
  ToolStep,
  TurnEvent,
  Usage,
  WireMessage,
} from "./types"
import { db, chatMessages } from "./db"
import { uid } from "./utils"
import { buildSystemPrompt, TITLE_PROMPT } from "./prompts"
import { completeText, streamChat } from "./providers"
import { getEnabledTools, executeTool } from "./tools"
import { contentWithoutArtifacts } from "./artifacts"
import { findEmotion } from "./emotions"
import { pip } from "@/pip/bus"
import { notifyChatDone, acquireWakeLock, releaseWakeLock } from "./notify"
import { estimateWireTokens, compactChat } from "./compact"
import { addUsage } from "./usage"
import { beginNewVersion } from "./versions"
import {
  attachCloudJob,
  createCloudJob,
  deleteCloudJob,
  stopCloudJob,
  CloudDetached,
  CloudJobGone,
} from "./cloud"
import { toast } from "sonner"
import { useStream } from "@/stores/stream"
import { useTemp } from "@/stores/temp"
import { useSettings, getSettings } from "@/stores/settings"
import { findModel } from "@/stores/models"

const MAX_TOOL_ROUNDS = 8
const PERSIST_INTERVAL = 700
/** auto-compact when the estimated prompt exceeds this share of the context */
const COMPACT_THRESHOLD = 0.7
/** a turn that dies on one of these spins Pip dizzy rather than flooring him */
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|usage limit reached|quota/i
/** re-attach backoff while the cloud runner is unreachable */
const ATTACH_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000]
/** consecutive failed attaches before we stop trying (≈ 8 minutes) */
const ATTACH_MAX_FAILURES = 36

export async function persistMessage(msg: Message, temporary: boolean) {
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
  let system = buildSystemPrompt(chat)
  if (chat?.summary) {
    system +=
      "\n\n## Earlier conversation (compacted)\nThe earlier part of this conversation was summarised to save space:\n" +
      chat.summary
  }
  const cutoff = chat?.summaryCutoff ?? 0
  const wire: WireMessage[] = [{ role: "system", content: system }]
  for (const m of history) {
    if (m.createdAt <= cutoff) continue
    if (m.role === "user") wire.push(attachmentsToWire(m))
    else if (m.content || m.images?.length)
      wire.push({ role: "assistant", content: m.content })
  }
  return wire
}

/** Compact automatically when the next request would crowd the context. */
async function maybeAutoCompact(
  chat: Chat,
  history: Message[],
  modelRef: ModelRef,
): Promise<Chat> {
  if (chat.kind !== "chat" || !getSettings().autoCompact) return chat
  const ctx = findModel(modelRef)?.ctx ?? 131_072
  if (estimateWireTokens(chat, history) < ctx * COMPACT_THRESHOLD) return chat
  try {
    // aggressive when hitting the limit: keep only the last exchange verbatim
    const { chat: updated, summarizedCount } = await compactChat(chat, history, {
      keepRecent: 2,
    })
    toast.info(
      `Auto-compacted ${summarizedCount} older message${summarizedCount === 1 ? "" : "s"} to fit the model's context`,
    )
    return updated
  } catch {
    return chat // best-effort: send anyway
  }
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
  const compacted = await maybeAutoCompact(chat, history, modelRef)
  await runAssistantTurn(compacted, history, modelRef, effort)
}

/**
 * Regenerate an assistant reply in place: the current generation is archived
 * as a version and a fresh one streams into the same message.
 *
 * Anything after the reply is removed first — those messages answered the
 * generation being replaced, so they can't stand (the caller confirms with
 * the user, as editing a user message does).
 */
export async function regenerateReply(
  chat: Chat,
  history: Message[],
  target: Message,
  modelRef: ModelRef,
  effort: Effort,
): Promise<void> {
  const temporary = !!chat.temporary
  const idx = history.findIndex((m) => m.id === target.id)
  if (idx < 0 || target.role !== "assistant") return
  // if the reply was already compacted away, the summary describes it
  if (target.createdAt <= (chat.summaryCutoff ?? 0)) {
    await patchChat(chat, { summary: undefined, summaryCutoff: 0 })
    chat = { ...chat, summary: undefined, summaryCutoff: 0 }
  }
  const after = history.slice(idx + 1)
  if (after.length) {
    const ids = after.map((m) => m.id)
    if (temporary) useTemp.getState().deleteMessages(chat.id, ids)
    else await db.messages.bulkDelete(ids)
  }
  await patchChat(chat, {
    provider: modelRef.provider,
    model: modelRef.model,
    effort,
    updatedAt: Date.now(),
  })
  useSettings.getState().set({ lastModel: modelRef, lastEffort: effort })
  await runAssistantTurn(chat, history.slice(0, idx), modelRef, effort, target)
}

/**
 * Rewrite a user message and regenerate from that point. Any messages after
 * it are removed (the caller confirms with the user first).
 */
export async function editUserMessage(
  chat: Chat,
  history: Message[],
  target: Message,
  newText: string,
  modelRef: ModelRef,
  effort: Effort,
): Promise<void> {
  const temporary = !!chat.temporary
  const idx = history.findIndex((m) => m.id === target.id)
  if (idx < 0) return
  // if the edited message was already compacted away, the summary is stale
  if (target.createdAt <= (chat.summaryCutoff ?? 0)) {
    await patchChat(chat, { summary: undefined, summaryCutoff: 0 })
    chat = { ...chat, summary: undefined, summaryCutoff: 0 }
  }
  const updated: Message = { ...target, content: newText, editedAt: Date.now() }
  await persistMessage(updated, temporary)
  const after = history.slice(idx + 1)
  if (after.length) {
    const ids = after.map((m) => m.id)
    if (temporary) useTemp.getState().deleteMessages(chat.id, ids)
    else await db.messages.bulkDelete(ids)
  }
  await patchChat(chat, {
    provider: modelRef.provider,
    model: modelRef.model,
    effort,
    updatedAt: Date.now(),
  })
  useSettings.getState().set({ lastModel: modelRef, lastEffort: effort })
  const newHistory = [...history.slice(0, idx), updated]
  const compacted = await maybeAutoCompact(chat, newHistory, modelRef)
  await runAssistantTurn(compacted, newHistory, modelRef, effort)
}

/**
 * The provider rounds + tool loop, flattened into TurnEvents. Runs on this
 * device; the cloud runner (server/cloud.mjs) mirrors this loop and journals
 * the same events, which is what lets one consumer drive both.
 */
async function* runLocalRounds(
  wire: WireMessage[],
  tools: ToolDef[],
  modelRef: ModelRef,
  effort: Effort,
  imageOutput: boolean,
  signal: AbortSignal,
): AsyncGenerator<TurnEvent> {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let toolCalls: import("./types").WireToolCall[] = []
    let roundUsage: Usage | undefined
    let roundGenStart = 0
    let content = ""

    for await (const ev of streamChat(modelRef.provider, {
      model: modelRef.model,
      messages: wire,
      effort,
      tools: tools.length ? tools : undefined,
      imageOutput,
      signal,
    })) {
      if (ev.type === "reasoning") {
        if (!roundGenStart) roundGenStart = Date.now()
        yield { t: "reasoning", x: ev.text }
      } else if (ev.type === "text") {
        if (!roundGenStart) roundGenStart = Date.now()
        content += ev.text
        yield { t: "text", x: ev.text }
      } else if (ev.type === "image") {
        if (!roundGenStart) roundGenStart = Date.now()
        yield { t: "image", dataUrl: ev.dataUrl }
      } else if (ev.type === "tool_calls") {
        toolCalls = ev.calls
      } else if (ev.type === "done" && ev.usage) {
        roundUsage = ev.usage
      }
    }

    if (roundUsage) {
      // Ollama times its own generation; for the rest, wall clock from
      // the round's first token is the honest approximation for tok/s
      if (roundUsage.genMs === undefined && roundGenStart)
        roundUsage.genMs = Date.now() - roundGenStart
      yield { t: "usage", usage: roundUsage }
    }

    if (!toolCalls.length) return

    // Record the assistant tool-call turn, execute, feed results back.
    wire.push({ role: "assistant", content, toolCalls })
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.args || "{}")
      } catch {
        /* leave empty */
      }
      yield { t: "tool", id: call.id, name: call.name, args }
      try {
        const result = await executeTool(call.name, args, signal)
        yield { t: "tool_result", id: call.id, result, ok: true }
        wire.push({
          role: "tool",
          content: result,
          toolCallId: call.id,
          toolName: call.name,
        })
      } catch (e) {
        const result = e instanceof Error ? e.message : "Tool failed"
        yield { t: "tool_result", id: call.id, result, ok: false }
        wire.push({
          role: "tool",
          content: `Error: ${result}`,
          toolCallId: call.id,
          toolName: call.name,
        })
      }
    }
  }
}

/** Resolves/aborts-quietly after ms, or immediately once signal aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (signal.aborted) done()
    else signal.addEventListener("abort", done)
  })
}

/**
 * Drive a turn that lives on the cloud runner: replay + live-tail its journal,
 * re-attaching through connection loss (each attach replays from the start,
 * so a "reset" precedes its entries). The user's Stop is forwarded to the
 * server rather than aborting the read — the journal then closes with
 * final:"stopped" and every token that made it out is kept.
 */
async function* runCloudRounds(
  jobId: string,
  controller: AbortController,
): AsyncGenerator<TurnEvent> {
  const attach = new AbortController()
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const onStop = () => {
    void stopCloudJob(jobId)
    // if the server's final doesn't reach us shortly, give up listening
    graceTimer = setTimeout(() => attach.abort(), 10_000)
  }
  if (controller.signal.aborted) onStop()
  else controller.signal.addEventListener("abort", onStop)

  try {
    let failures = 0
    while (true) {
      let replayed = false
      try {
        for await (const entry of attachCloudJob(jobId, attach.signal)) {
          if (!replayed) {
            // the journal replays from 0 — the message starts over with it
            replayed = true
            failures = 0
            yield { t: "reset" }
          }
          yield entry
          if (entry.t === "final") return
        }
      } catch (e) {
        if (e instanceof CloudJobGone) throw e
        if (attach.signal.aborted) throw e
        /* transient — fall through to the backoff below */
      }
      // stream dropped before the final entry: back off, attach again
      failures++
      if (failures >= ATTACH_MAX_FAILURES) throw new CloudDetached()
      await wait(
        ATTACH_BACKOFF_MS[Math.min(failures, ATTACH_BACKOFF_MS.length) - 1],
        attach.signal,
      )
    }
  } finally {
    controller.signal.removeEventListener("abort", onStop)
    clearTimeout(graceTimer)
  }
}

/**
 * Apply a turn's events to the message: accumulate state, mirror it into the
 * live-stream store and IndexedDB, then finalise — status, usage, notify,
 * title. Local and cloud turns (including catch-up replays) all end here.
 */
async function consumeTurn(
  chat: Chat,
  history: Message[],
  msg: Message,
  events: AsyncGenerator<TurnEvent>,
  controller: AbortController,
): Promise<void> {
  const temporary = !!chat.temporary
  const isImage = chat.kind === "image"
  void acquireWakeLock()

  let content = ""
  let reasoning = ""
  let reasoningStart = 0
  let reasoningMs: number | undefined
  /* the hidden <emotion> tag opens the reply — watch the head of the
     stream and hand the mood to Pip the moment it completes (a no-op
     when he isn't mounted). A misplaced tag is still caught by the final
     full-text scan when the turn ends. */
  let emotionSent = false
  let emotionHeadDone = false
  const feedEmotion = (finished = false) => {
    if (emotionSent || isImage || (emotionHeadDone && !finished)) return
    const emo = findEmotion(finished ? content : content.slice(0, 600))
    if (emo) {
      emotionSent = true
      pip.emote(emo)
    } else if (content.length > 600) emotionHeadDone = true
  }
  let steps: ToolStep[] = []
  let images: { id: string; dataUrl: string }[] = []
  let usage: Usage | undefined
  let lastPersist = Date.now()
  let finalStatus: Message["status"] = "done"
  let errorText: string | undefined
  let serverFinal: Extract<TurnEvent, { t: "final" }> | undefined
  /** the cloud job vanished / became unreachable mid-turn */
  let lostJob: CloudJobGone | CloudDetached | undefined
  /** a detach leaves the job (possibly still running) collectable later */
  let keepJob = false
  /** did the event stream produce anything at all this session? */
  let sawAnyEvent = false

  const snapshot = (): Message => ({
    ...msg,
    content,
    reasoning: reasoning || undefined,
    reasoningMs,
    steps: steps.length ? steps.map((s) => ({ ...s })) : undefined,
    images: images.length ? [...images] : undefined,
    usage,
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
    for await (const ev of events) {
      sawAnyEvent = true
      let force = false
      switch (ev.t) {
        case "reset":
          content = ""
          reasoning = ""
          reasoningStart = 0
          reasoningMs = undefined
          steps = []
          images = []
          usage = undefined
          break
        case "reasoning":
          if (!reasoning) reasoningStart = Date.now()
          reasoning += ev.x
          break
        case "text":
          if (reasoningStart && reasoningMs === undefined)
            reasoningMs = Date.now() - reasoningStart
          content += ev.x
          feedEmotion()
          break
        case "image":
          // some providers repeat the same image in later stream chunks
          if (!images.some((im) => im.dataUrl === ev.dataUrl))
            images.push({ id: uid(), dataUrl: ev.dataUrl })
          break
        case "tool":
          // prose so far belonged to the tool round, as in the wire echo
          content = ""
          steps.push({ id: ev.id, name: ev.name, args: ev.args, status: "running" })
          force = true
          break
        case "tool_result": {
          const step = steps.find((s) => s.id === ev.id)
          if (step) {
            step.result = ev.result
            step.status = ev.ok ? "done" : "error"
          }
          force = true
          break
        }
        case "usage":
          usage = addUsage(usage, ev.usage)
          break
        case "final":
          serverFinal = ev
          break
      }
      pushLive(force)
      await maybePersist(force)
    }
    if (serverFinal) {
      finalStatus = serverFinal.status
      errorText = serverFinal.error
      if (serverFinal.reasoningMs !== undefined)
        reasoningMs = serverFinal.reasoningMs
      if (finalStatus === "error" && errorText)
        pip.mishap(RATE_LIMITED.test(errorText) ? "rate" : "error")
    }
  } catch (e) {
    if (controller.signal.aborted) {
      finalStatus = "stopped"
    } else if (e instanceof CloudJobGone || e instanceof CloudDetached) {
      // On a detach the job may still finish server-side, so keep the
      // pointer — the next resume pass collects or discards it.
      lostJob = e
      keepJob = e instanceof CloudDetached
    } else {
      finalStatus = "error"
      errorText = e instanceof Error ? e.message : String(e)
      /* Pip takes it personally: a rate limit spins him dizzy, anything
         else puts him flat on his back (no-op when he isn't mounted) */
      pip.mishap(RATE_LIMITED.test(errorText) ? "rate" : "error")
    }
  }

  clearTimeout(pushTimer)
  // A resume that never got a single event back must not clobber the
  // partial output an earlier session already persisted on the message.
  if (!sawAnyEvent && (msg.content || msg.images?.length)) {
    content = msg.content
    reasoning = msg.reasoning ?? ""
    reasoningMs = msg.reasoningMs
    steps = msg.steps ? msg.steps.map((s) => ({ ...s })) : []
    images = msg.images ? [...msg.images] : []
    usage = msg.usage
  }
  if (lostJob) {
    // what streamed (this session or before) is kept; "Continue generating"
    // takes it from there
    finalStatus = content || images.length ? "interrupted" : "error"
    if (finalStatus === "error") errorText = lostJob.message
  }
  if (reasoningStart && reasoningMs === undefined)
    reasoningMs = Date.now() - reasoningStart
  if (finalStatus === "done") feedEmotion(true)

  const jobId = msg.cloudJobId
  const finalMsg: Message = {
    ...snapshot(),
    status: finalStatus,
    error: errorText,
    cloudJobId: keepJob ? jobId : undefined,
  }
  await persistMessage(finalMsg, temporary)
  await patchChat(chat, { updatedAt: Date.now() })
  useStream.getState().end(chat.id, msg.id)
  if (!Object.keys(useStream.getState().generating).length) releaseWakeLock()
  // collected in full — the server can forget the journal (and, on error
  // or stop, anything it was still doing)
  if (jobId && !keepJob) void deleteCloudJob(jobId)

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

async function runAssistantTurn(
  chat: Chat,
  history: Message[],
  modelRef: ModelRef,
  effort: Effort,
  reuseMsg?: Message,
): Promise<void> {
  const temporary = !!chat.temporary
  const isImage = chat.kind === "image"
  const modelInfo = findModel(modelRef)
  // temporary chats promise to touch nothing but this device's memory —
  // they never hand a turn to the server
  const cloud = chat.runtime === "cloud" && !temporary

  const msg: Message = reuseMsg
    ? {
        ...beginNewVersion(reuseMsg),
        provider: modelRef.provider,
        model: modelRef.model,
        modelName: modelInfo?.name,
        effort,
        status: "streaming",
        cloudJobId: undefined, // a past run's pointer must not survive
      }
    : {
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
  const controller = useStream.getState().begin(chat.id, msg.id)

  const wire = buildWireHistory(chat, history)
  const tools = !isImage && (modelInfo?.tools ?? true) ? getEnabledTools() : []

  let events: AsyncGenerator<TurnEvent>
  if (cloud) {
    try {
      const jobId = await createCloudJob({
        modelRef,
        effort,
        messages: wire,
        tools,
        imageOutput: isImage,
      })
      msg.cloudJobId = jobId
      // the pointer is what lets a later launch find the reply again —
      // persist it before a single token arrives
      await persistMessage({ ...msg }, temporary)
      events = runCloudRounds(jobId, controller)
    } catch (e) {
      // the turn never reached the server — surface through the shared path
      events = (async function* () {
        throw e
      })() as AsyncGenerator<TurnEvent>
    }
  } else {
    events = runLocalRounds(wire, tools, modelRef, effort, isImage, controller.signal)
  }
  await consumeTurn(chat, history, msg, events, controller)
}

/**
 * Catch up on turns the cloud runner may have finished (or still be running)
 * while this device was away. Called at boot and whenever the app comes back
 * to the foreground or online — cheap when there's nothing to do.
 */
let resumeScanRunning = false
export async function resumeCloudTurns(): Promise<void> {
  if (resumeScanRunning) return
  resumeScanRunning = true
  try {
    const stale = await db.messages
      .filter(
        (m) =>
          !!m.cloudJobId &&
          (m.status === "streaming" ||
            m.status === "pending" ||
            m.status === "interrupted"),
      )
      .toArray()
    if (!stale.length) return
    const byChat = new Map<string, Message[]>()
    for (const m of stale)
      byChat.set(m.chatId, [...(byChat.get(m.chatId) ?? []), m])
    for (const [chatId, msgs] of byChat) {
      // something is already driving this chat (live turn or earlier resume)
      if (useStream.getState().generating[chatId]) continue
      const chat = await db.chats.get(chatId)
      const all = chat ? await chatMessages(chatId) : []
      const last = all[all.length - 1]
      for (const m of msgs) {
        if (!chat || m.id !== last?.id) {
          // chat gone or the conversation moved on — the job is stale
          void deleteCloudJob(m.cloudJobId!)
          if (chat)
            await db.messages.update(m.id, {
              cloudJobId: undefined,
              ...(m.status === "interrupted"
                ? {}
                : {
                    status:
                      m.content || m.images?.length ? "interrupted" : "error",
                    error: m.content
                      ? undefined
                      : "Interrupted before any output",
                  }),
            })
          continue
        }
        const resumed: Message = { ...m, status: "streaming" }
        await persistMessage(resumed, false)
        const controller = useStream.getState().begin(chat.id, resumed.id)
        const history = all.slice(0, -1)
        // deliberately not awaited: chats catch up in parallel, and the
        // generating map above keeps a second scan from double-attaching
        void consumeTurn(
          chat,
          history,
          resumed,
          runCloudRounds(m.cloudJobId!, controller),
          controller,
        )
      }
    }
  } finally {
    resumeScanRunning = false
  }
}

/** Used by the /title command with no argument. */
export async function regenerateChatTitle(
  chat: Chat,
  history: Message[],
): Promise<void> {
  const assistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content && m.status === "done")
  if (!assistant) throw new Error("No finished reply to name the chat from yet")
  await generateTitle({ ...chat, titleIsManual: false }, history, assistant)
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
