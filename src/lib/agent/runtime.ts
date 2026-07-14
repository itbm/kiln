import { db } from "@/lib/db"
import { notifyChatDone } from "@/lib/notify"
import type {
  AgentMeta,
  AgentRunExtras,
  AgentSessionStatus,
  Chat,
  Message,
  ModelRef,
  ToolStep,
} from "@/lib/types"
import { AGENT_TERMINAL_STATES } from "@/lib/types"
import { uid } from "@/lib/utils"
import { getSettings } from "@/stores/settings"
import { useAgentConn } from "@/stores/agent"
import * as api from "./client"
import type { AgentEvent, AgentPermissionMode, AgentNetworkPolicy } from "./types"

/**
 * Bridges runner sessions into Kiln's local-first model: every received
 * event is folded into the chat's messages in IndexedDB — the phone is the
 * only durable transcript store (§5.6). On foreground/reconnect we
 * re-subscribe from `?after=lastSeq`, so nothing is lost while the app was
 * closed; the runner's ring buffer replays the gap.
 */

const PERSIST_INTERVAL = 700
const RECONNECT_MIN_MS = 2_000
const RECONNECT_MAX_MS = 30_000

interface Fold {
  chatId: string
  sessionId: string
  assistantId: string
  content: string
  reasoning: string
  steps: ToolStep[]
  extras: AgentRunExtras
  errorText?: string
  status: AgentSessionStatus
  lastSeq: number
  lastPersist: number
  persistTimer?: ReturnType<typeof setTimeout>
  socket?: { close: () => void }
  reconnectTimer?: ReturnType<typeof setTimeout>
  reconnectDelay: number
  detached: boolean
}

const folds = new Map<string, Fold>()

/* ------------------------------------------------------------ provider ---- */

export function providerFor(ref: ModelRef): { baseUrl: string; token: string } {
  const s = getSettings()
  if (ref.provider === "openrouter")
    return { baseUrl: "https://openrouter.ai/api", token: s.openrouterKey }
  return { baseUrl: "https://ollama.com", token: s.ollamaKey }
}

/* -------------------------------------------------------------- start ---- */

export interface StartTaskOptions {
  task: string
  repoOwner: string
  repoName: string
  baseBranch: string
  modelRef: ModelRef
  permissionMode: AgentPermissionMode
  networkPolicy: AgentNetworkPolicy
  allowPackageManagers: boolean
  extraHosts: string[]
}

/** Create a runner session + its agent chat. Returns the chat id. */
export async function startAgentTask(opts: StartTaskOptions): Promise<string> {
  const s = getSettings()
  if (!s.agentRunnerToken) throw new Error("Configure the agent runner in Settings first")
  if (!s.agentGithubToken) throw new Error("Add a GitHub token in Settings → Agent runner")
  if (!s.agentJournalKey) s.set({ agentJournalKey: api.generateJournalKey() })
  const provider = providerFor(opts.modelRef)
  if (!provider.token)
    throw new Error(`Add your ${opts.modelRef.provider} API key in Settings first`)

  const created = await api.createSession({
    task: opts.task,
    repo: { owner: opts.repoOwner, name: opts.repoName, baseBranch: opts.baseBranch },
    provider: { ...provider, model: opts.modelRef.model, smallModel: smallModelFor(opts.modelRef) },
    github: { token: s.agentGithubToken },
    options: {
      permissionMode: opts.permissionMode,
      network: {
        policy: opts.networkPolicy,
        allowPackageManagers: opts.allowPackageManagers,
        extraHosts: opts.extraHosts,
      },
    },
  })

  const now = Date.now()
  const chatId = uid()
  const chat: Chat = {
    id: chatId,
    kind: "agent",
    title: opts.task.slice(0, 64),
    createdAt: now,
    updatedAt: now,
    provider: opts.modelRef.provider,
    model: opts.modelRef.model,
    agentMeta: {
      runnerSessionId: created.id,
      repo: `${opts.repoOwner}/${opts.repoName}`,
      baseBranch: opts.baseBranch,
      taskBranch: created.taskBranch,
      status: created.state,
      lastSeq: 0,
      attempt: 1,
    },
  }
  await db.chats.add(chat)
  await beginRun(chat, opts.task, created.id)
  s.set({
    lastAgentModel: opts.modelRef,
    lastAgentRepo: `${opts.repoOwner}/${opts.repoName}`,
    lastAgentBaseBranch: opts.baseBranch,
  })
  return chatId
}

/**
 * Continue (also "follow up") or retry a terminal session (§5.8): same
 * `POST /sessions` with a resume seed — the task branch plus a compacted
 * client-held transcript. Git is authoritative; the transcript is advisory.
 */
export async function resumeAgentTask(
  chat: Chat,
  history: Message[],
  mode: "continue" | "retry",
  followUp?: string,
): Promise<void> {
  const meta = chat.agentMeta
  if (!meta) throw new Error("Not an agent chat")
  const s = getSettings()
  const [owner, name] = meta.repo.split("/")
  if (!owner || !name) throw new Error("Chat has no repository")
  const modelRef: ModelRef =
    chat.provider && chat.model
      ? { provider: chat.provider, model: chat.model }
      : s.lastAgentModel ?? (() => { throw new Error("Pick a model first") })()
  const provider = providerFor(modelRef)
  if (!provider.token) throw new Error(`Add your ${modelRef.provider} API key in Settings first`)

  const firstTask = history.find((m) => m.role === "user")?.content ?? chat.title
  const task =
    mode === "continue"
      ? followUp?.trim() ||
        "Continue the task from where the branch left off; finish anything incomplete."
      : firstTask

  const created = await api.createSession({
    task,
    repo: { owner, name, baseBranch: meta.baseBranch },
    provider: { ...provider, model: modelRef.model, smallModel: smallModelFor(modelRef) },
    github: { token: s.agentGithubToken },
    options: {
      permissionMode: s.agentPermissionMode,
      network: {
        policy: s.agentNetworkPolicy,
        allowPackageManagers: s.agentAllowPackageManagers,
        extraHosts: parseExtraHosts(s.agentExtraHosts),
      },
    },
    resume: {
      taskBranch: meta.taskBranch,
      mode,
      history: buildResumeHistory(chat, history, mode === "continue" ? firstTask : undefined),
    },
  })

  const patch: Partial<AgentMeta> = {
    runnerSessionId: created.id,
    taskBranch: created.taskBranch,
    status: created.state,
    lastSeq: 0,
    attempt: (meta.attempt ?? 1) + 1,
  }
  if (mode === "retry") patch.prUrl = undefined
  await db.chats.update(chat.id, {
    agentMeta: { ...meta, ...patch },
    updatedAt: Date.now(),
  })
  const label =
    followUp?.trim() || (mode === "continue" ? "Continue from the branch" : "Retry from scratch")
  await beginRun({ ...chat, agentMeta: { ...meta, ...patch } }, label, created.id)
}

/** Persist the user turn + a fresh assistant shell, then attach the stream. */
async function beginRun(chat: Chat, userText: string, sessionId: string): Promise<void> {
  const now = Date.now()
  const userMsg: Message = {
    id: uid(),
    chatId: chat.id,
    role: "user",
    content: userText,
    status: "done",
    createdAt: now,
  }
  const assistant: Message = {
    id: uid(),
    chatId: chat.id,
    role: "assistant",
    content: "",
    provider: chat.provider,
    model: chat.model,
    status: "streaming",
    createdAt: now + 1,
  }
  await db.messages.bulkAdd([userMsg, assistant])
  detach(chat.id)
  const fold: Fold = {
    chatId: chat.id,
    sessionId,
    assistantId: assistant.id,
    content: "",
    reasoning: "",
    steps: [],
    extras: {},
    status: chat.agentMeta?.status ?? "created",
    lastSeq: 0,
    lastPersist: 0,
    reconnectDelay: RECONNECT_MIN_MS,
    detached: false,
  }
  folds.set(chat.id, fold)
  connect(fold)
}

/* -------------------------------------------------------------- attach ---- */

/**
 * Re-attach a chat to its live session (app open, foreground, reconnect).
 * Rebuilds fold state from IndexedDB so the `after=lastSeq` replay appends
 * cleanly instead of duplicating.
 */
export async function ensureAttached(chat: Chat): Promise<void> {
  const meta = chat.agentMeta
  if (!meta || AGENT_TERMINAL_STATES.has(meta.status)) return
  const existing = folds.get(chat.id)
  if (existing && !existing.detached) return

  const msgs = await db.messages.where("chatId").equals(chat.id).toArray()
  msgs.sort((a, b) => a.createdAt - b.createdAt)
  const assistant = [...msgs].reverse().find((m) => m.role === "assistant")
  if (!assistant) return
  const fold: Fold = {
    chatId: chat.id,
    sessionId: meta.runnerSessionId,
    assistantId: assistant.id,
    content: assistant.content ?? "",
    reasoning: assistant.reasoning ?? "",
    steps: (assistant.steps ?? []).map((s) => ({ ...s })),
    extras: assistant.agent ? { ...assistant.agent } : {},
    status: meta.status,
    lastSeq: meta.lastSeq ?? 0,
    lastPersist: 0,
    reconnectDelay: RECONNECT_MIN_MS,
    detached: false,
  }
  folds.set(chat.id, fold)
  connect(fold)
}

export function detach(chatId: string): void {
  const fold = folds.get(chatId)
  if (!fold) return
  fold.detached = true
  clearTimeout(fold.reconnectTimer)
  clearTimeout(fold.persistTimer)
  fold.socket?.close()
  folds.delete(chatId)
  useAgentConn.getState().setConn(chatId, null)
}

function connect(fold: Fold): void {
  useAgentConn.getState().setConn(fold.chatId, "connecting")
  fold.socket = api.openEvents(fold.sessionId, fold.lastSeq, {
    onOpen: () => {
      fold.reconnectDelay = RECONNECT_MIN_MS
      useAgentConn.getState().setConn(fold.chatId, "live")
    },
    onEvent: (ev) => void foldEvent(fold, ev),
    onClose: (deliberate) => {
      if (deliberate || fold.detached) return
      useAgentConn.getState().setConn(fold.chatId, "offline")
      if (AGENT_TERMINAL_STATES.has(fold.status)) return
      fold.reconnectTimer = setTimeout(() => void probeAndReconnect(fold), fold.reconnectDelay)
      fold.reconnectDelay = Math.min(fold.reconnectDelay * 2, RECONNECT_MAX_MS)
    },
  })
}

/**
 * A dropped stream is usually the network — but after an agentd restart the
 * session is simply gone (its loop can't survive; §5.7). Distinguish the
 * two: unreachable runner → keep backing off; a definitive "session not
 * found" → mark the run interrupted so the UI offers Continue.
 */
async function probeAndReconnect(fold: Fold): Promise<void> {
  if (fold.detached) return
  try {
    await api.getSession(fold.sessionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ""
    if (/not found/i.test(msg)) {
      fold.status = "interrupted"
      await patchMeta(fold, { status: "interrupted" })
      await finishRun(fold, "interrupted")
      return
    }
    // network/offline — fall through and let the socket retry
  }
  if (!fold.detached) connect(fold)
}

/* -------------------------------------------------------------- folding ---- */

async function foldEvent(fold: Fold, ev: AgentEvent): Promise<void> {
  if (ev.seq > 0) {
    if (ev.seq <= fold.lastSeq) return // duplicate after reconnect race
    fold.lastSeq = ev.seq
  }
  const p = ev.payload
  switch (ev.type) {
    case "state": {
      const status = String(p.state ?? "") as AgentSessionStatus
      fold.status = status
      await patchMeta(fold, { status })
      if (AGENT_TERMINAL_STATES.has(status)) await finishRun(fold, status)
      return
    }
    case "bootstrap":
      upsertStep(fold, {
        id: `bootstrap-${ev.seq}`,
        name: "bootstrap",
        args: {},
        result: typeof p.output === "string" ? p.output : undefined,
        status: p.exitCode === 0 ? "done" : "error",
      })
      break
    case "assistant_text": {
      const text = typeof p.text === "string" ? p.text : ""
      if (p.thinking === true) fold.reasoning += (fold.reasoning ? "\n\n" : "") + text
      else fold.content += (fold.content ? "\n\n" : "") + text
      break
    }
    case "tool_use":
      upsertStep(fold, {
        id: String(p.id ?? `tool-${ev.seq}`),
        name: String(p.tool ?? "tool"),
        args: (p.input as Record<string, unknown>) ?? {},
        status: "running",
      })
      break
    case "tool_result": {
      const step = fold.steps.find((s) => s.id === String(p.id ?? ""))
      if (step) {
        step.result = typeof p.output === "string" ? p.output : ""
        step.status = p.isError === true ? "error" : "done"
      }
      break
    }
    case "diff":
      fold.extras.diff = {
        stat: String(p.stat ?? ""),
        patch: typeof p.patch === "string" ? p.patch : undefined,
        truncated: p.truncated === true,
      }
      break
    case "pr": {
      const url = String(p.url ?? "")
      if (url) {
        fold.extras.prUrl = url
        await patchMeta(fold, { prUrl: url })
      }
      break
    }
    case "result":
      fold.extras.result = {
        durationMs: numberOr(p.durationMs),
        costUsd: numberOr(p.costUsd),
        turns: numberOr(p.turns),
        isError: p.isError === true,
      }
      break
    case "warning": {
      const msg = String(p.message ?? "")
      if (msg) fold.content += `${fold.content ? "\n\n" : ""}> ⚠︎ ${msg}`
      break
    }
    case "error":
      fold.errorText = String(p.message ?? "agent error")
      break
  }
  persistSoon(fold)
}

function upsertStep(fold: Fold, step: ToolStep): void {
  const existing = fold.steps.find((s) => s.id === step.id)
  if (existing) Object.assign(existing, step)
  else fold.steps.push(step)
}

function snapshot(fold: Fold, status: Message["status"]): Partial<Message> {
  return {
    content: fold.content,
    reasoning: fold.reasoning || undefined,
    steps: fold.steps.length ? fold.steps.map((s) => ({ ...s })) : undefined,
    agent: Object.keys(fold.extras).length ? { ...fold.extras } : undefined,
    error: fold.errorText,
    status,
  }
}

function persistSoon(fold: Fold): void {
  const write = () => {
    fold.lastPersist = Date.now()
    void db.messages.update(fold.assistantId, snapshot(fold, "streaming"))
    void db.chats
      .where("id")
      .equals(fold.chatId)
      .modify((c) => {
        if (c.agentMeta) c.agentMeta.lastSeq = fold.lastSeq
        c.updatedAt = Date.now()
      })
  }
  if (Date.now() - fold.lastPersist > PERSIST_INTERVAL) write()
  else if (!fold.persistTimer)
    fold.persistTimer = setTimeout(() => {
      fold.persistTimer = undefined
      write()
    }, PERSIST_INTERVAL)
}

async function patchMeta(fold: Fold, patch: Partial<AgentMeta>): Promise<void> {
  await db.chats
    .where("id")
    .equals(fold.chatId)
    .modify((c) => {
      if (c.agentMeta) Object.assign(c.agentMeta, patch, { lastSeq: fold.lastSeq })
      c.updatedAt = Date.now()
    })
}

async function finishRun(fold: Fold, status: AgentSessionStatus): Promise<void> {
  clearTimeout(fold.persistTimer)
  fold.persistTimer = undefined
  const msgStatus: Message["status"] =
    status === "completed"
      ? "done"
      : status === "cancelled"
        ? "stopped"
        : status === "interrupted"
          ? "interrupted"
          : "error"
  if (msgStatus === "error" && !fold.errorText)
    fold.errorText = status === "expired" ? "Session expired (TTL reached)" : "Session failed"
  await db.messages.update(fold.assistantId, snapshot(fold, msgStatus))
  const chat = await db.chats.get(fold.chatId)
  if (chat) {
    const preview =
      status === "completed"
        ? fold.extras.prUrl
          ? `PR ready: ${fold.extras.prUrl}`
          : "Task finished"
        : `Session ${status}`
    void notifyChatDone(chat.id, chat.title, preview, `/code/${chat.id}`)
  }
  detach(fold.chatId)
}

/* ------------------------------------------------------------- history ---- */

const HISTORY_BUDGET = 24_000
const PER_MESSAGE_CAP = 2_000

/**
 * Deterministic, offline transcript digest for resume (§5.8). Walks from the
 * most recent message backwards until the budget is spent — a long history
 * costs input tokens, not correctness, because the agent grounds itself in
 * git first. The chat's compaction summary (if any) rides along.
 */
export function buildResumeHistory(
  chat: Chat,
  history: Message[],
  originalTask?: string,
): string {
  const lines: string[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    const parts: string[] = []
    if (m.role === "user") parts.push(`USER: ${m.content.slice(0, PER_MESSAGE_CAP)}`)
    else {
      for (const s of m.steps ?? [])
        parts.push(
          `TOOL ${s.name}${s.status === "error" ? " (failed)" : ""}: ${JSON.stringify(s.args).slice(0, 200)}`,
        )
      if (m.content) parts.push(`ASSISTANT: ${m.content.slice(0, PER_MESSAGE_CAP)}`)
      if (m.error) parts.push(`ERROR: ${m.error.slice(0, 400)}`)
    }
    const text = parts.join("\n")
    if (!text) continue
    if (used + text.length > HISTORY_BUDGET) break
    used += text.length
    lines.unshift(text)
  }
  const head: string[] = []
  if (originalTask) head.push(`ORIGINAL TASK: ${originalTask.slice(0, PER_MESSAGE_CAP)}`)
  if (chat.summary) head.push(`EARLIER (compacted): ${chat.summary.slice(0, 4_000)}`)
  return [...head, ...lines].join("\n\n").trim()
}

/* -------------------------------------------------------------- helpers ---- */

/** Mid-task steering: forward to the shim and record the user turn locally. */
export async function steerAgent(chat: Chat, text: string): Promise<void> {
  const meta = chat.agentMeta
  if (!meta) throw new Error("Not an agent chat")
  await api.sendInput(meta.runnerSessionId, text)
  await db.messages.add({
    id: uid(),
    chatId: chat.id,
    role: "user",
    content: text,
    status: "done",
    createdAt: Date.now(),
  })
  await db.chats.update(chat.id, { updatedAt: Date.now() })
}

function smallModelFor(ref: ModelRef): string | undefined {
  const t = getSettings().titleModel
  return t && t.provider === ref.provider ? t.model : undefined
}

export function parseExtraHosts(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean)
    .slice(0, 32)
}

function numberOr(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
