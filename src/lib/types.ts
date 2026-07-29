// Type-only import: erased at compile time, so types.ts stays a runtime leaf.
import type { QuestionSpec } from "./questions"

export type ProviderId = "openrouter" | "ollama"

/**
 * Reasoning effort. "auto" = don't send anything (model default). Other
 * values come from the provider per model: OpenRouter supported_efforts
 * ("max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none"),
 * Ollama think levels ("high" | "medium" | "low"), or "on"/"off" for
 * models where thinking can only be toggled.
 */
export type Effort = string

export interface ModelRef {
  provider: ProviderId
  model: string
}

export interface ModelInfo {
  id: string
  provider: ProviderId
  name: string
  ctx?: number
  vision?: boolean
  reasoning?: boolean
  imageOutput?: boolean
  tools?: boolean
  /** discrete effort levels this model accepts (provider-reported) */
  efforts?: string[]
  /** thinking can be switched on/off (but has no levels) */
  reasoningToggle?: boolean
  /** provider default effort, shown next to "Auto" */
  defaultEffort?: string
  /** USD per million tokens */
  pricing?: { prompt?: number; completion?: number }
}

/**
 * Provider-reported usage for one generation. Token counts and cost come
 * straight from the provider (OpenRouter usage accounting / Ollama eval
 * counts) — never estimated. All fields optional: providers report what
 * they know.
 */
export interface Usage {
  promptTokens?: number
  completionTokens?: number
  /** subset of completionTokens spent on reasoning (OpenRouter) */
  reasoningTokens?: number
  /** subset of promptTokens served from the provider's cache (OpenRouter) */
  cachedTokens?: number
  /** USD actually charged (OpenRouter credits; absent for subscription/local providers) */
  cost?: number
  /** time spent generating output, ms (Ollama eval_duration, else wall clock) */
  genMs?: number
}

export type ChatKind = "chat" | "image" | "code"

/**
 * The repository a code chat works in. `baseBranch` is what the user picked
 * and is never written to; `workBranch` is where the agent's commits land.
 */
export interface CodeRepo {
  owner: string
  name: string
  defaultBranch: string
  baseBranch: string
  workBranch: string
  private: boolean
}

/**
 * Where assistant turns run. "local" (default) streams from the provider on
 * this device; "cloud" hands the turn to the Kiln server's runner so closing
 * the app doesn't lose the reply — the device catches up and stores the
 * result locally, as always.
 */
export type ChatRuntime = "local" | "cloud"

export interface Chat {
  id: string
  kind: ChatKind
  title: string
  createdAt: number
  updatedAt: number
  provider?: ProviderId
  model?: string
  effort?: Effort
  /** absent = "local" (also: temporary chats always run locally) */
  runtime?: ChatRuntime
  skillIds?: string[]
  /** temporary chats are never written to the database */
  temporary?: boolean
  /** when the chat was pinned to the top of the list (absent = not pinned) */
  pinned?: number
  titleIsManual?: boolean
  titleGenerated?: boolean
  /** compaction: summary of messages with createdAt <= summaryCutoff */
  summary?: string
  summaryCutoff?: number
  /** code chats: the repository and branches this chat works in */
  repo?: CodeRepo
  /** code chats: the sbx sandbox currently serving this chat, if any */
  sandboxName?: string
  /** code chats: the harness session to resume after a process or VM restart */
  agentSessionId?: string
}

export type AttachmentKind = "image" | "text" | "pdf"

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  kind: AttachmentKind
  dataUrl?: string
  text?: string
}

export interface ToolStep {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  status: "running" | "done" | "error"
}

export interface GenImage {
  id: string
  dataUrl: string
}

export type MessageStatus =
  | "pending"
  | "streaming"
  | "done"
  | "stopped"
  | "interrupted"
  | "error"

export interface Message {
  id: string
  chatId: string
  role: "user" | "assistant"
  content: string
  reasoning?: string
  reasoningMs?: number
  steps?: ToolStep[]
  attachments?: Attachment[]
  images?: GenImage[]
  provider?: ProviderId
  model?: string
  modelName?: string
  effort?: Effort
  status: MessageStatus
  error?: string
  createdAt: number
  editedAt?: number
  /**
   * The server-side job generating this reply (cloud runtime). Present only
   * while the result hasn't been fully collected — cleared on finalisation,
   * so its presence marks a turn that may still be running remotely.
   */
  cloudJobId?: string
  /**
   * The server-side job generating this reply (code chats). Mirrors
   * cloudJobId: present only while the result hasn't been collected, so its
   * presence marks a turn that may still be running in a sandbox.
   */
  forgeJobId?: string
  /** provider-reported tokens/cost for the active generation */
  usage?: Usage
  /** the user has submitted answers to this message's <questions> block */
  questionsAnswered?: boolean
  /** alternative generations (regenerations); active one lives on the message itself */
  versions?: Generation[]
  /** position of the active generation in the full ordering; defaults to versions.length */
  versionIndex?: number
}

/** A snapshot of one assistant generation, for the version switcher. */
export interface Generation {
  content: string
  reasoning?: string
  reasoningMs?: number
  steps?: ToolStep[]
  images?: GenImage[]
  provider?: ProviderId
  model?: string
  modelName?: string
  effort?: Effort
  status: MessageStatus
  error?: string
  createdAt: number
  usage?: Usage
}

/**
 * An unsent composer message. Keyed by chat id (or one of the NEW_*_DRAFT
 * keys before the chat exists), so a half-written message survives leaving
 * the chat, a reload, or iOS discarding the PWA in the background.
 */
export interface Draft {
  id: string
  text: string
  attachments?: Attachment[]
  updatedAt: number
}

export interface Skill {
  id: string
  name: string
  description: string
  instructions: string
  /** on by default for new chats */
  enabled: boolean
}

/** Provider-agnostic wire format used by the engine */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /** image data URLs */
  images?: string[]
  /** non-image files (pdf) */
  files?: { name: string; dataUrl: string }[]
  toolCalls?: WireToolCall[]
  /** for role:"tool" results */
  toolCallId?: string
  toolName?: string
}

export interface WireToolCall {
  id: string
  name: string
  /** JSON string */
  args: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; dataUrl: string }
  | { type: "tool_calls"; calls: WireToolCall[] }
  | { type: "done"; finish?: string; usage?: Usage }

/**
 * One event of an assistant turn, provider rounds and tool execution
 * flattened into a single stream. The local engine loop yields these, and
 * they are exactly the entries of the cloud runner's journal (which adds a
 * `seq` number) — change them together with server/cloud.mjs.
 *
 * "reset" never appears in a journal: the client inserts it when it
 * (re)attaches to a job, because a replay starts from the beginning and the
 * accumulated message state must start over with it.
 */
export type TurnEvent =
  | { t: "text"; x: string }
  | { t: "reasoning"; x: string }
  | { t: "image"; dataUrl: string }
  | { t: "tool"; id: string; name: string; args: Record<string, unknown> }
  | { t: "tool_result"; id: string; result: string; ok: boolean }
  | { t: "usage"; usage: Usage }
  | {
      t: "final"
      status: "done" | "stopped" | "error"
      error?: string
      reasoningMs?: number
    }
  | { t: "reset" }
  /* --- code chats (forge runtime) --- */
  /** the harness session id, so a later turn can resume it */
  | { t: "session"; id: string }
  /**
   * The agent needs an answer before it can continue: a permission prompt or
   * an AskUserQuestion. Rendered by the existing <questions> chip UI, and
   * answered back through the forge's /reply route.
   */
  | { t: "ask"; requestId: string; kind: "permission" | "question"; questions: QuestionSpec[] }
  /** work pushed to a branch */
  | {
      t: "branch"
      name: string
      url: string
      commits: number
      filesChanged: number
    }

export interface ChatRequest {
  model: string
  messages: WireMessage[]
  effort: Effort
  tools?: ToolDef[]
  /** request image output (OpenRouter image models) */
  imageOutput?: boolean
  signal?: AbortSignal
}
