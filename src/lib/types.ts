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

export type ChatKind = "chat" | "image"

export interface Chat {
  id: string
  kind: ChatKind
  title: string
  createdAt: number
  updatedAt: number
  provider?: ProviderId
  model?: string
  effort?: Effort
  skillIds?: string[]
  /** temporary chats are never written to the database */
  temporary?: boolean
  titleIsManual?: boolean
  titleGenerated?: boolean
  /** compaction: summary of messages with createdAt <= summaryCutoff */
  summary?: string
  summaryCutoff?: number
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

export interface ChatRequest {
  model: string
  messages: WireMessage[]
  effort: Effort
  tools?: ToolDef[]
  /** request image output (OpenRouter image models) */
  imageOutput?: boolean
  signal?: AbortSignal
}
